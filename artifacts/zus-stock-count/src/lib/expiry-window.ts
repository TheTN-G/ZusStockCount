export type ExpiryRadarBatch = {
  quantity: number;
  expiryDate?: string | null;
};

export function filterExpiryRadarBatches<T extends ExpiryRadarBatch>(
  batches: readonly T[],
  now = new Date(),
): T[] {
  const firstDay = now.toISOString().slice(0, 10);
  const lastDayDate = new Date(`${firstDay}T00:00:00.000Z`);
  lastDayDate.setUTCDate(lastDayDate.getUTCDate() + 7);
  const lastDay = lastDayDate.toISOString().slice(0, 10);

  return batches.filter((batch) => {
    const expiryDay = batch.expiryDate?.slice(0, 10);
    return batch.quantity > 0 && Boolean(expiryDay) && expiryDay! >= firstDay && expiryDay! <= lastDay;
  });
}
