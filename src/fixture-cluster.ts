/** Stable record names for deterministic multi-cluster fixtures only. Not Story parsing. */
export function fixtureCluster(milestone: string) {
  const prefix = milestone === "milestone.disclosure" ? "" : milestone.slice(10) + "-";
  const slug = (name: string) => name.startsWith(prefix) ? name : prefix + name;
  const text = (value: string) => value.replace(/\b(event|choice-point|puzzle|revelation|authored-content)\.([a-z][a-z0-9-]*)/g,
    (_, type: string, name: string) => type + "." + slug(name));
  const path = (value: string) => value.replace(/^(events|choice-points|puzzles|revelations|authored-content)\/([a-z][a-z0-9-]*)\.md$/,
    (_, folder: string, name: string) => folder + "/" + slug(name) + ".md");
  return { slug, text, path };
}
