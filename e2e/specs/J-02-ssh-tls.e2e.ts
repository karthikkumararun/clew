import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { $, expect } from "@wdio/globals";
import { covers } from "../helpers/covers";
import { withDataDir } from "../helpers/dataDir";
import { chooseOption } from "../helpers/forms";
import { ConnectionDialog } from "../pages/ConnectionDialog";
import { Welcome } from "../pages/Welcome";

// J-02 connect through the SSH bastion with a key and verify-full TLS, including the host-key
// prompt and the refusal when the bastion's key changed. Needs the `core` compose profile.
describe("J-02 SSH and TLS", () => {
  const data = withDataDir();
  const keys = resolve("docker", "bastion", "keys");
  const certs = resolve("docker", "postgres-tls", "certs");
  const knownHosts = join(data.dir, "known_hosts");
  const result = () => $('[role="status"], [role="alert"]');

  // a failed step must not leave the dialog open for the next one
  afterEach(async () => {
    const cancel = await ConnectionDialog.cancelButton();
    if (await cancel.isExisting()) await cancel.click();
  });

  const fillPostgres = async (name: string, host: string, port: number) => {
    await ConnectionDialog.fillNetwork({
      name,
      host,
      port,
      user: "clew",
      password: "clew",
      database: "clew",
    });
  };
  const selectOption = (label: string, text: string) =>
    chooseOption($(`.//label[normalize-space()="${label}"]/following::select[1]`), text);

  it(`connects with verify-full TLS and the right CA`, async () => {
    await Welcome.newConnection().waitForDisplayed({ timeout: 30_000 });
    await Welcome.newConnection().click();
    await fillPostgres("tls-pg", "localhost", 54317);
    await ConnectionDialog.tab("SSL / TLS").click();
    await selectOption("SSL mode", "verify-full");
    await expect($('.//label[normalize-space()="SSL mode"]/following::select[1]')).toHaveValue(
      "verify-full",
    );
    await $("aria/CA certificate").setValue(join(certs, "ca.crt"));
    await ConnectionDialog.testButton().click();
    await expect($('[role="status"]')).toHaveText(expect.stringContaining("Connected"), {
      wait: 20_000,
    });
  });

  const openBastionDialog = async (name: string) => {
    await $("aria/New connection").click();
    // the target is the compose service name, which only the bastion can resolve
    await fillPostgres(name, "postgres", 5432);
    await ConnectionDialog.tab("SSH tunnel").click();
    await $("aria/Connect through an SSH tunnel").click();
    await $("aria/SSH host").setValue("127.0.0.1");
    await $("aria/SSH port").setValue("2222");
    await $("aria/SSH user").setValue("tunnel");
    await selectOption("Authentication", "Key file");
    await $('.//label[normalize-space()="Key file"]/following::input[1]').setValue(
      join(keys, "client_ed25519"),
    );
  };

  it(`refuses a bastion whose host key changed ${covers("driver-framework › Changed host key")}`, async () => {
    // a known_hosts entry for the bastion that holds some other key
    const other = readFileSync(join(keys, "client_ed25519.pub"), "utf8")
      .trim()
      .split(" ")
      .slice(0, 2)
      .join(" ");
    writeFileSync(knownHosts, `[127.0.0.1]:2222 ${other}\n`);
    await $("aria/New connection").waitForDisplayed();
    await openBastionDialog("ssh-pg-changed");
    await ConnectionDialog.testButton().click();
    await expect($('[role="alert"]')).toHaveText(expect.stringMatching(/host key/i), {
      wait: 30_000,
    });
  });

  it(`asks about an unknown bastion key and connects through the tunnel after Trust ${covers("driver-framework › Unknown host key")}`, async () => {
    rmSync(knownHosts, { force: true });
    await openBastionDialog("ssh-pg");
    await ConnectionDialog.testButton().click();
    // the host-key prompt opens on top of the connection dialog
    const prompt = await $('.//*[@role="dialog"][contains(., "Unknown SSH host")]');
    await prompt.waitForDisplayed({ timeout: 30_000 });
    await prompt.$('.//button[normalize-space()="Trust and continue"]').click();
    await $('[role="status"], [role="alert"]').waitForDisplayed({ timeout: 30_000 });
    const text = await $('[role="status"], [role="alert"]').getText();
    expect(text).toContain("Connected");
  });
});
