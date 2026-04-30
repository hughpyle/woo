export type NormalizedVerbPerms = {
  perms: string;
  directCallable: boolean;
};

export function normalizeVerbPerms(rawPerms: string, directCallable = false): NormalizedVerbPerms {
  return {
    perms: rawPerms.replace(/d/g, ""),
    directCallable: directCallable || rawPerms.includes("d")
  };
}
