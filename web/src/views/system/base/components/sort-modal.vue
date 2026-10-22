<template>
  <a-modal v-model:visible="visible" :title="title" :width="560" :footer="false" @cancel="onClose">
    <div class="sort-tip">
      <icon-drag-arrow />
      拖动调整顺序，或点击上下箭头微调；在 API 设置中点击「提交」后保存。
    </div>
    <div v-if="items.length" ref="listRef" class="sort-list">
      <div
        v-for="(item, index) in items"
        :key="item.value"
        class="sort-item"
        :class="{
          'is-dragging': draggingIndex === index,
          'is-over': overIndex === index && draggingIndex !== null && draggingIndex !== index && overIndex > draggingIndex
        }"
        draggable="true"
        @dragstart="onDragStart(index)"
        @dragover.prevent="onDragOver(index)"
        @drop.prevent="onDrop(index)"
        @dragend="onDragEnd"
      >
        <span class="sort-handle" aria-hidden="true"><icon-drag-arrow /></span>
        <span class="sort-index">{{ index + 1 }}</span>
        <div class="sort-info">
          <span class="sort-name">{{ item.label }}</span>
          <span class="sort-key">{{ item.value }}</span>
        </div>
        <div class="sort-actions">
          <a-button
            type="text"
            size="mini"
            shape="circle"
            html-type="button"
            aria-label="上移"
            :disabled="index === 0"
            @click="move(index, -1)"
          >
            <template #icon><icon-up /></template>
          </a-button>
          <a-button
            type="text"
            size="mini"
            shape="circle"
            html-type="button"
            aria-label="下移"
            :disabled="index === items.length - 1"
            @click="move(index, 1)"
          >
            <template #icon><icon-down /></template>
          </a-button>
        </div>
      </div>
    </div>
    <a-empty v-else :description="emptyText" />
  </a-modal>
</template>

<script setup lang="ts">
/**
 * 通用排序弹窗：拖拽 + 上下箭头调整顺序。
 * 通过 v-model:order 读写「值数组」，父组件负责与配置字符串互转。
 */
interface SortItem {
  value: string;
  label: string;
}

const props = withDefaults(
  defineProps<{
    title: string;
    emptyText?: string;
    // 逗号分隔的已保存顺序（受控）
    order: string;
    // 全部可选项（已按默认顺序排好）
    options: SortItem[];
  }>(),
  { emptyText: "暂无可选项", order: "" }
);

const emit = defineEmits<{ (e: "update:order", value: string): void }>();
const visible = defineModel<boolean>("visible", { default: false });

const draggingIndex = ref<number | null>(null);
const overIndex = ref<number | null>(null);

/** 已保存顺序在前（去重、忽略非法值），其余按默认顺序补齐 */
const items = computed<SortItem[]>(() => {
  const valid = new Map(props.options.map((o) => [o.value, o]));
  const seen = new Set<string>();
  const result: SortItem[] = [];

  for (const raw of props.order.split(",")) {
    const key = raw.trim();
    if (!key || seen.has(key)) continue;
    const item = valid.get(key);
    if (!item) continue;

    seen.add(key);
    result.push(item);
  }

  for (const item of props.options) {
    if (!seen.has(item.value)) result.push(item);
  }

  return result;
});

const commit = (next: SortItem[]) => emit("update:order", next.map((i) => i.value).join(","));

const move = (index: number, offset: number) => {
  const target = index + offset;
  if (target < 0 || target >= items.value.length) return;

  const next = [...items.value];
  [next[index], next[target]] = [next[target], next[index]];
  commit(next);
};

const onDragStart = (index: number) => {
  draggingIndex.value = index;
};

const onDragOver = (index: number) => {
  if (draggingIndex.value === null) return;
  overIndex.value = index;
};

const onDrop = (index: number) => {
  const from = draggingIndex.value;
  if (from === null || from === index) return;

  const next = [...items.value];
  const [moved] = next.splice(from, 1);
  next.splice(index, 0, moved);
  commit(next);
};

const onDragEnd = () => {
  draggingIndex.value = null;
  overIndex.value = null;
};

const onClose = () => {
  onDragEnd();
};
</script>

<style lang="scss" scoped>
.sort-tip {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 12px;
  color: $color-text-3;
  font-size: $font-size-body-2;
}

.sort-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 52vh;
  overflow-y: auto;
  padding-right: 2px;
}

.sort-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--color-border-2);
  border-radius: 6px;
  background: var(--color-bg-2);
  cursor: grab;
  transition: border-color 0.15s, box-shadow 0.15s, opacity 0.15s;

  &:hover {
    border-color: rgb(var(--primary-6));
  }

  &.is-dragging {
    opacity: 0.45;
    cursor: grabbing;
  }

  /* 被拖到其上方时，下方项目让位提示线 */
  &.is-over {
    border-color: rgb(var(--primary-6));
    box-shadow: 0 -2px 0 0 rgb(var(--primary-6));
  }
}

.sort-handle {
  color: var(--color-text-4);
  font-size: 14px;
  cursor: grab;
}

.sort-index {
  flex: none;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: rgb(var(--primary-6), 0.12);
  color: rgb(var(--primary-6));
  font-size: $font-size-body-2;
  font-weight: 600;
  line-height: 22px;
  text-align: center;
}

.sort-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.sort-name {
  color: var(--color-text-1);
  font-size: $font-size-body-2;
  font-weight: 500;
}

.sort-key {
  color: var(--color-text-3);
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.sort-actions {
  display: flex;
  gap: 2px;
}
</style>