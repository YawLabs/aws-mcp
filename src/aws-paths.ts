import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where the AWS CLI's shared files live, resolved the way botocore does it.
 *
 * botocore reads AWS_CONFIG_FILE and AWS_SHARED_CREDENTIALS_FILE (expanding a
 * leading `~`) before falling back to ~/.aws/config and ~/.aws/credentials.
 * Every in-process read or write of those files must resolve through here, so
 * the server and the `aws` subprocess it spawns -- which inherits the same
 * environment -- always agree on the file. A one-process-per-user deployment
 * that points these variables at per-user files depends on that agreement.
 *
 * Both are read per call, never cached: the environment is the configuration.
 */
export function resolveAwsConfigPath(): string {
  return fromEnvOrDefault(process.env.AWS_CONFIG_FILE, "config");
}

export function resolveAwsCredentialsPath(): string {
  return fromEnvOrDefault(process.env.AWS_SHARED_CREDENTIALS_FILE, "credentials");
}

function fromEnvOrDefault(raw: string | undefined, basename: string): string {
  const fromEnv = raw?.trim();
  if (!fromEnv) return join(homedir(), ".aws", basename);
  // Mirror botocore's expanduser() so `~/cfg` means <home>/cfg rather than a
  // literal `~` directory next to the cwd.
  if (fromEnv === "~") return homedir();
  if (fromEnv.startsWith("~/") || fromEnv.startsWith("~\\")) return join(homedir(), fromEnv.slice(2));
  return fromEnv;
}
