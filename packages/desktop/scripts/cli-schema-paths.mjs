const SCHEMA_PATH_PREFIXES = ["../../../../schemas/", "../../../schemas/"];

/**
 * tsup folds Core modules into resources/cli.js, so their source-relative schema
 * URLs must point at the sibling resources/schemas directory in the installer.
 */
export function rewriteBundledCliSchemaPaths(source) {
  let output = source;
  let replacementCount = 0;

  for (const prefix of SCHEMA_PATH_PREFIXES) {
    const occurrences = output.split(prefix).length - 1;
    if (occurrences === 0) {
      throw new Error(`CLI bundle is missing expected schema path prefix: ${prefix}`);
    }
    output = output.replaceAll(prefix, "./schemas/");
    replacementCount += occurrences;
  }

  return { source: output, replacementCount };
}
