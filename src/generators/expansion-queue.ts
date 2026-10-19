// Matches the legacy FlatQueue heap, including equal-priority ordering.
export class ExpansionQueue<T> {
  private ids: T[] = [];
  private values: number[] = [];
  length = 0;
  push(value: T, priority: number) {
    let i = this.length++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const p = this.values[parent];
      if (priority >= p) break;
      this.ids[i] = this.ids[parent];
      this.values[i] = p;
      i = parent;
    }
    this.ids[i] = value;
    this.values[i] = priority;
  }
  pop(): T | undefined {
    if (!this.length) return;
    const result = this.ids[0];
    if (--this.length > 0) {
      const value = this.ids[this.length],
        priority = this.values[this.length];
      let i = 0;
      while (i < this.length >> 1) {
        let child = 1 + (i << 1);
        const right = child + 1;
        if (right < this.length && this.values[right] < this.values[child]) child = right;
        if (this.values[child] >= priority) break;
        this.ids[i] = this.ids[child];
        this.values[i] = this.values[child];
        i = child;
      }
      this.ids[i] = value;
      this.values[i] = priority;
    }
    return result;
  }
}
