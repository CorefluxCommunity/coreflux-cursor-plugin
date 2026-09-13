// Shared classification of Coreflux broker commands that must not run without explicit approval.

export const DESTRUCTIVE_VERBS = new Map([
  ["-removeallroutes", "deletes every route on the broker"],
  ["-removeallmodels", "deletes every model on the broker"],
  ["-removeallactions", "deletes every action on the broker"],
  ["-removeallpythonscripts", "deletes every Python script on the broker"],
  ["-removeallthemes", "deletes every theme on the broker"],
  ["-removealltracelogs", "deletes every trace-log sink"],
  ["-removeproject", "deletes a project from the broker's disk"],
  ["-unloadproject", "unloads the active project and all of its entities"],
  ["-removeuser", "deletes an MQTT user"],
  ["-restorerules", "resets the shipped permission rules"],
  ["-changeuserpassword", "changes a user's password"],
  ["-changeusersettings", "changes a user's permission flags"],
  ["-loadlicense", "replaces the broker licence"],
]);

/**
 * Normalises a verb such as `--remove-all-routes` or `-removeAllRoutes` to `-removeallroutes`.
 */
export function normaliseVerb(verb) {
  return `-${String(verb ?? "").replace(/^-+/, "").replace(/-/g, "").toLowerCase()}`;
}

/**
 * Returns the reason a command payload is destructive, or null when it is safe.
 */
export function destructiveReason(commandPayload) {
  const verb = String(commandPayload ?? "").trim().split(/\s+/)[0];
  if (!verb) return null;
  return DESTRUCTIVE_VERBS.get(normaliseVerb(verb)) ?? null;
}

export function readStdinJson() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => {
      try {
        resolve(data.trim() ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
    process.stdin.on("error", () => resolve({}));
  });
}

export function respond(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}
