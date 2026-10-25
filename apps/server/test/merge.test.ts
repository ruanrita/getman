import { describe, expect, it } from "vitest";
import { newCollection, newEnvironment, newFolder, newRequest, variable, type Collection, type Folder, type RequestItem } from "@getman/core";
import { mergeCollection, mergeEnvironment, removedItems } from "../src/merge";

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

function base(): Collection {
  const c = newCollection("API");
  const auth = newFolder("Auth");
  auth.items.push(newRequest("Login", "POST", "/login"), newRequest("Logout", "POST", "/logout"));
  c.items.push(auth, newRequest("List", "GET", "/items"), newRequest("Get", "GET", "/items/1"));
  c.variables.push(variable("host", "a"), variable("v", "1"));
  return c;
}
const req = (c: Collection, name: string) => {
  const all = (items: Collection["items"]): RequestItem[] => items.flatMap((i) => (i.kind === "request" ? [i] : all(i.items)));
  return all(c.items).find((r) => r.name === name)!;
};

describe("collection merge", () => {
  it("merges edits to different requests", () => {
    const b = base();
    const ours = clone(b);
    req(ours, "List").url = "/v2/items";
    const theirs = clone(b);
    req(theirs, "Login").url = "/v2/login";
    const { merged, conflicts } = mergeCollection(b, ours, theirs);
    expect(conflicts).toEqual([]);
    expect(req(merged, "List").url).toBe("/v2/items");
    expect(req(merged, "Login").url).toBe("/v2/login");
    expect(merged.items.map((i) => i.name)).toEqual(["Auth", "List", "Get"]);
  });

  it("reports the same request changed differently and keeps theirs", () => {
    const b = base();
    const ours = clone(b);
    req(ours, "Get").url = "/ours";
    const theirs = clone(b);
    req(theirs, "Get").url = "/theirs";
    const { merged, conflicts } = mergeCollection(b, ours, theirs);
    expect(conflicts).toEqual([{ kind: "request", id: req(b, "Get").id, name: "Get", reason: "both_changed" }]);
    expect(req(merged, "Get").url).toBe("/theirs");
  });

  it("identical changes on both sides are not a conflict", () => {
    const b = base();
    const ours = clone(b);
    const theirs = clone(b);
    req(ours, "Get").url = req(theirs, "Get").url = "/same";
    expect(mergeCollection(b, ours, theirs).conflicts).toEqual([]);
  });

  it("keeps additions from both sides", () => {
    const b = base();
    const ours = clone(b);
    ours.items.push(newRequest("Ours new"));
    const theirs = clone(b);
    (theirs.items[0] as Folder).items.push(newRequest("Theirs new"));
    const { merged, conflicts } = mergeCollection(b, ours, theirs);
    expect(conflicts).toEqual([]);
    expect(merged.items.map((i) => i.name)).toContain("Ours new");
    expect((merged.items[0] as Folder).items.map((i) => i.name)).toEqual(["Login", "Logout", "Theirs new"]);
  });

  it("applies deletions, and flags delete-vs-edit", () => {
    const b = base();
    const ours = clone(b);
    ours.items = ours.items.filter((i) => i.name !== "List"); // we delete List
    req(ours, "Get").url = "/edited-by-us";
    const theirs = clone(b);
    theirs.items = theirs.items.filter((i) => i.name !== "Get"); // they delete Get
    const { merged, conflicts } = mergeCollection(b, ours, theirs);
    expect(merged.items.map((i) => i.name)).toEqual(["Auth"]);
    expect(conflicts).toEqual([expect.objectContaining({ name: "Get", reason: "deleted_by_them" })]);
  });

  it("moves a child to the root when the other side deleted its folder", () => {
    const b = base();
    const ours = clone(b);
    (ours.items[0] as Folder).items.push(newRequest("Refresh"));
    const theirs = clone(b);
    theirs.items = theirs.items.filter((i) => i.name !== "Auth");
    const { merged } = mergeCollection(b, ours, theirs);
    expect(merged.items.map((i) => i.name)).toContain("Refresh");
  });

  it("merges settings and variables by field and key", () => {
    const b = base();
    const ours = clone(b);
    ours.description = "docs";
    ours.variables.find((v) => v.key === "host")!.value = "ours";
    const theirs = clone(b);
    theirs.auth = { type: "bearer", token: "{{t}}" };
    theirs.variables.push(variable("new", "x"));
    const { merged, conflicts } = mergeCollection(b, ours, theirs);
    expect(conflicts).toEqual([]);
    expect(merged.description).toBe("docs");
    expect(merged.auth).toEqual({ type: "bearer", token: "{{t}}" });
    expect(merged.variables.map((v) => `${v.key}=${v.value}`)).toEqual(["host=ours", "v=1", "new=x"]);

    const theirs2 = clone(b);
    theirs2.variables.find((v) => v.key === "host")!.value = "theirs";
    expect(mergeCollection(b, ours, theirs2).conflicts).toEqual([expect.objectContaining({ kind: "variable", name: "host" })]);
  });

  it("lists removed items for the trash", () => {
    const b = base();
    const after = clone(b);
    after.items = after.items.filter((i) => i.name !== "Auth" && i.name !== "Get");
    expect(removedItems(b.items, after.items).map((r) => r.item.name)).toEqual(["Auth", "Get"]);
  });
});

describe("environment merge", () => {
  it("merges variables by key", () => {
    const b = newEnvironment("Dev");
    b.variables.push(variable("a", "1"), variable("b", "2"));
    const ours = clone(b);
    ours.variables[0]!.value = "10";
    const theirs = clone(b);
    theirs.variables[1]!.value = "20";
    theirs.name = "Development";
    const { merged, conflicts } = mergeEnvironment(b, ours, theirs);
    expect(conflicts).toEqual([]);
    expect(merged.name).toBe("Development");
    expect(merged.variables.map((v) => v.value)).toEqual(["10", "20"]);
  });
});
