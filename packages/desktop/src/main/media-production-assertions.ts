export function hasMediaProgressEvidence(mainProgressCount: number, rendererProgressCount: number): boolean {
  return mainProgressCount > 0 && rendererProgressCount > 0;
}
