/**
 * Literals that fake-aws.ts emits AND a test has to know byte-for-byte. They
 * live here, not in fake-aws.ts, because importing fake-aws.ts runs its
 * scenario dispatch -- a test can import this module, never that one.
 */

/**
 * The URL+code tail the sso2_raw_* scenarios print after their filler.
 * startSsoLogin settles only once both are parsed, so a settled start proves
 * the whole payload is in the parent's buffer, and sso.integration.test.ts
 * builds its expected rawOutput from this same constant.
 */
export const SSO2_TAIL = "\nhttps://device.sso.us-east-1.amazonaws.com/\nABCD-EFGH\n";
