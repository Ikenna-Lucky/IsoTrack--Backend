export function integrationShard(files, value) {
  if (value === undefined)
    return { files, shard: null, reportName: "integration" };
  const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(value);
  const index = Number(match?.[1]);
  const total = Number(match?.[2]);
  if (
    !Number.isSafeInteger(index) ||
    !Number.isSafeInteger(total) ||
    index > total ||
    total > files.length
  ) {
    throw new Error(
      "Shard must be index/total with 1 <= index <= total <= file count",
    );
  }
  return {
    files: files.filter((_, position) => position % total === index - 1),
    shard: { index, total },
    reportName: `integration-${index}-of-${total}`,
  };
}
