import { expect } from "@wdio/globals";
import { launchApp } from "../helpers/app";
import { connectionFactory, seedConnections } from "../helpers/connections";
import { withDataDir } from "../helpers/dataDir";
import { Explorer } from "../pages/Explorer";

// Hello world: the real app starts in test mode against an isolated profile with a seeded
// connection, and restarts with the same data directory.
describe("J-00 hello", () => {
  const data = withDataDir();

  it("starts with a seeded connection in the explorer", async () => {
    seedConnections(data.dir, [connectionFactory.sqlite("hello-sqlite", `${data.dir}/hello.db`)]);
    await launchApp(data);
    await expect(Explorer.connection("hello-sqlite")).toBeDisplayed();
  });

  it("sees the same connection after a relaunch", async () => {
    await launchApp(data);
    await expect(Explorer.connection("hello-sqlite")).toBeDisplayed();
  });
});
