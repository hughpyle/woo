import { describe, expect, it } from "vitest";
import { signInternalRequest, verifyInternalRequest } from "../src/worker/internal-auth";

const env = { WOO_INTERNAL_SECRET: "test-secret" };

describe("worker internal auth", () => {
  it("verifies signed internal requests and rejects body tampering", async () => {
    const signed = await signInternalRequest(env, new Request("https://woo.internal/__internal/remote-dispatch", {
      method: "POST",
      headers: { "content-type": "application/json", "x-woo-host-key": "the_chatroom" },
      body: JSON.stringify({ ok: true })
    }));

    await expect(verifyInternalRequest(env, signed.clone())).resolves.toBeUndefined();

    const tampered = new Request(signed.url, {
      method: signed.method,
      headers: signed.headers,
      body: JSON.stringify({ ok: false })
    });
    await expect(verifyInternalRequest(env, tampered)).rejects.toMatchObject({ code: "E_PERM" });
  });

  it("rejects unsigned internal requests", async () => {
    const unsigned = new Request("https://woo.internal/register-session", {
      method: "POST",
      body: "{}"
    });
    await expect(verifyInternalRequest(env, unsigned)).rejects.toMatchObject({ code: "E_NOSESSION" });
  });
});
