// Only the disclosure-level half of SessionController is covered here. The
// credential half needs STS and is exercised by driving the real portal.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionController } from "./session.js";
import { STORAGE_KEY } from "./disclosure.js";

/** An in-memory Storage stand-in — happy-dom provides no localStorage. */
function fakeStorage(initial?: Record<string, string>) {
  const map = new Map(Object.entries(initial ?? {}));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

describe("SessionController disclosure level", () => {
  let storage: ReturnType<typeof fakeStorage>;

  beforeEach(() => {
    storage = fakeStorage();
  });

  it("starts at guided for a first-time visitor", () => {
    expect(new SessionController("us-east-1", storage).level).toBe("guided");
  });

  it("adopts a remembered level", () => {
    expect(new SessionController("us-east-1", fakeStorage({ [STORAGE_KEY]: "expert" })).level).toBe(
      "expert",
    );
  });

  it("persists a change", () => {
    const s = new SessionController("us-east-1", storage);
    s.setLevel("standard");
    expect(storage.getItem(STORAGE_KEY)).toBe("standard");
    // A preference must survive a reload the way any preference does.
    expect(new SessionController("us-east-1", storage).level).toBe("standard");
  });

  it("works with persistence disabled", () => {
    const s = new SessionController("us-east-1", null);
    s.setLevel("expert");
    expect(s.level).toBe("expert");
  });

  it("notifies listeners on a change", () => {
    const s = new SessionController("us-east-1", storage);
    const fn = vi.fn();
    s.onLevelChange(fn);
    s.setLevel("expert");
    expect(fn).toHaveBeenCalledWith("expert");
  });

  it("stays silent on a no-op change", () => {
    // The shell re-mounts the current surface on every notification. Firing for a
    // set-to-same would tear down and rebuild a surface — losing whatever the user
    // had typed into it — for no change at all.
    const s = new SessionController("us-east-1", storage);
    const fn = vi.fn();
    s.onLevelChange(fn);
    s.setLevel(s.level);
    expect(fn).not.toHaveBeenCalled();
  });

  it("unsubscribes", () => {
    const s = new SessionController("us-east-1", storage);
    const fn = vi.fn();
    s.onLevelChange(fn)();
    s.setLevel("expert");
    expect(fn).not.toHaveBeenCalled();
  });

  it("keeps the level across a sign-out", () => {
    // An experienced user who signs out and back in must not be dropped into
    // guided mode — which is why the level lives on the session rather than being
    // rebuilt with the credentials.
    const s = new SessionController("us-east-1", storage);
    s.setLevel("expert");
    s.clear();
    expect(s.level).toBe("expert");
  });
});
