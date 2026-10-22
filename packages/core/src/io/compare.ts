/** Python 参考脚本的逐码元字符串排序；不依赖区域设置。 */
export function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
