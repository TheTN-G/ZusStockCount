export type CountDraft = { bundles: string; loose: string };

export function hasCountInput(draft: CountDraft): boolean {
  return draft.bundles !== "" || draft.loose !== "";
}

export function countTotal(draft: CountDraft, bundleSize: number): number | null {
  if (!hasCountInput(draft)) return null;
  const bundles = draft.bundles === "" ? 0 : Number(draft.bundles);
  const loose = draft.loose === "" ? 0 : Number(draft.loose);
  if (
    !Number.isSafeInteger(bundles) ||
    !Number.isSafeInteger(loose) ||
    bundles < 0 ||
    loose < 0
  ) {
    return null;
  }
  const size = Number.isFinite(bundleSize) && bundleSize > 0 ? bundleSize : 1;
  const total = bundles * size + loose;
  return Number.isSafeInteger(total) ? total : null;
}

export function splitCount(total: number, bundleSize: number): CountDraft {
  const size = Number.isFinite(bundleSize) && bundleSize > 1 ? bundleSize : 1;
  if (size === 1) return { bundles: "", loose: String(total) };
  return {
    bundles: String(Math.floor(total / size)),
    loose: String(total % size),
  };
}
