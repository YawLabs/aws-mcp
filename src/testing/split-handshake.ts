/**
 * The parent half of fake-aws.ts's writeSplitStdout handshake, for tests that
 * need the fake's stdout to arrive as genuinely separate 'data' events.
 *
 * The product code under test (runAwsCall, startSsoLogin) owns the child's
 * stdout listener, so a test cannot observe its 'data' events directly. What it
 * CAN observe is the fake's ready file `<ready>.<i>`, which the fake creates only
 * after chunk i's write callback -- the bytes are in the pipe by then. The test
 * process is the product's process, so it then yields until its own event loop
 * has passed through a poll phase (two setImmediate turns: immediates run in the
 * check phase, which follows poll), in which the product's listener consumes
 * the already-readable chunk, and only then creates `<release>.<i>`, the fake's
 * go-ahead for chunk i+1. Chunk i+1 cannot be in the pipe before chunk i was
 * read, so the two cannot coalesce.
 */

import { randomUUID } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SplitHandshake {
  /** Merge into the fake's environment. */
  env: { AWS_MCP_FAKE_READY_OUT: string; AWS_MCP_FAKE_RELEASE_FILE: string };
  /** Settles once every boundary has been released; rejects if the fake never reaches one. */
  done: Promise<void>;
  /**
   * Await the product call alongside `done`, and return its result. A product
   * that fails -- rejects, or resolves `{ ok: false }` -- stops the handshake at
   * once, so the test reports the product's own failure instead of sitting out
   * the ready-file deadline (a fake killed early never writes it). A successful
   * product keeps the handshake running: startSsoLogin resolves on the URL while
   * the fake may still be holding later chunks for their release.
   */
  run<T>(product: Promise<T>): Promise<T>;
  /** Stop waiting and remove the side-channel files. Call from `finally`. */
  cleanup(): void;
}

const yieldPastPoll = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
};

/**
 * Drive `boundaries` split points (one fewer than the fake's chunk count).
 * `timeoutMs` bounds the wait for each ready file -- a hang guard sized for the
 * fake's cold start on a starved machine, not a timing assumption.
 */
export function splitHandshake(boundaries: number, timeoutMs = 60_000): SplitHandshake {
  const base = join(tmpdir(), `aws-mcp-split-${process.pid}-${randomUUID()}`);
  const ready = `${base}.ready`;
  const release = `${base}.release`;
  let stopped = false;
  const done = (async () => {
    for (let i = 1; i <= boundaries; i++) {
      const deadline = Date.now() + timeoutMs;
      while (!existsSync(`${ready}.${i}`)) {
        if (stopped) return;
        if (Date.now() > deadline) throw new Error(`splitHandshake: the fake never flushed chunk ${i}`);
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      await yieldPastPoll();
      // cleanup() may have run during the yield; writing now would leave a stray
      // release file behind it.
      if (stopped) return;
      writeFileSync(`${release}.${i}`, "go");
    }
  })();
  return {
    env: { AWS_MCP_FAKE_READY_OUT: ready, AWS_MCP_FAKE_RELEASE_FILE: release },
    done,
    async run<T>(product: Promise<T>): Promise<T> {
      const watched = product.then(
        (r) => {
          if ((r as { ok?: unknown } | null)?.ok === false) stopped = true;
          return r;
        },
        (err: unknown) => {
          stopped = true;
          throw err;
        },
      );
      const [r] = await Promise.all([watched, done]);
      return r;
    },
    cleanup() {
      stopped = true;
      for (let i = 1; i <= boundaries; i++) {
        rmSync(`${ready}.${i}`, { force: true });
        rmSync(`${release}.${i}`, { force: true });
      }
    },
  };
}
