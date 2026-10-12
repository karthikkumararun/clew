import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { browser, expect } from "@wdio/globals";
import { launchApp } from "../helpers/app";
import { connectionFactory, seedConnections, seedPassword } from "../helpers/connections";
import { covers } from "../helpers/covers";
import { withDataDir } from "../helpers/dataDir";
import { queueDialog } from "../helpers/dialogs";
import { Exchange } from "../pages/Exchange";

// J-09 encrypted connection export and import, wrong passphrase and tampered file.
describe("J-09 export and import", () => {
  const data = withDataDir();
  const file =
    "/private/tmp/claude-501/-Users-karthikarun-AI-projects-clew/5c951376-4b42-401c-8d06-173adabac8d7/scratchpad/connections.clew";
  const PASSWORD = "s3cret-db-password";
  const PASSPHRASE = "correct horse battery staple";

  before(async () => {
    const c = connectionFactory.network("postgres", "exchange-pg", {
      port: 54316,
      database: "clew",
      user: "clew",
    });
    seedConnections(data.dir, [c]);
    seedPassword(data.dir, c.id, PASSWORD);
    await launchApp(data);
  });

  it(`writes an encrypted file that does not contain the password ${covers("connection-management › Export with passwords and an SSH key")}`, async () => {
    await Exchange.open("export");
    const passwords = await Exchange.checkbox("Saved passwords");
    if (!(await passwords.isSelected())) await passwords.click();
    await Exchange.passphrase().setValue(PASSPHRASE);
    await Exchange.confirm().setValue(PASSPHRASE);
    queueDialog(data.dialogQueue, file);
    await Exchange.button("Export…").click();
    await browser.waitUntil(async () => existsSync(file), {
      timeoutMsg: "the .clew file should be written",
    });
    const bytes = readFileSync(file);
    expect(bytes.includes(PASSWORD)).toBe(false);
    expect(bytes.includes("exchange-pg")).toBe(false); // settings are encrypted too
  });

  it(`rejects a wrong passphrase ${covers("connection-management › Wrong passphrase")}`, async () => {
    await Exchange.open("import");
    await Exchange.source("Clew export").click();
    queueDialog(data.dialogQueue, file);
    await Exchange.button("Choose a file…").click();
    await Exchange.unlock().setValue("not the passphrase");
    await Exchange.button("Unlock").click();
    await expect(Exchange.alert()).toHaveText(expect.stringContaining("doesn't unlock this file"), {
      wait: 20_000,
    });
  });

  it(`rejects a tampered file ${covers("connection-management › Tampered file")}`, async () => {
    const bytes = readFileSync(file);
    // change one character inside the base64 payload, so the file is still valid JSON
    const at = bytes.indexOf('"payload": "') + '"payload": "'.length + 20;
    bytes[at] = bytes[at] === 0x41 ? 0x42 : 0x41;
    const tampered = join(data.dir, "..", "tampered.clew");
    writeFileSync(tampered, bytes);
    await Exchange.button("Cancel").click(); // start the import again with the damaged file
    await Exchange.open("import");
    await Exchange.source("Clew export").click();
    queueDialog(data.dialogQueue, tampered);
    await Exchange.button("Choose a file…").click();
    await Exchange.unlock().setValue(PASSPHRASE);
    await Exchange.button("Unlock").click();
    await expect(Exchange.alert()).toHaveText(expect.stringContaining("damaged"), { wait: 20_000 });
  });
});
