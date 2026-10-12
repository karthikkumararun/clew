import { $ } from "@wdio/globals";
import type { Environment } from "../../src/lib/ipc/generated/Environment";

/** The New/Edit connection dialog. Fields are found by their visible labels. */
export const ConnectionDialog = {
  driver: (name: string) => $(`aria/${name}`),
  field: (label: string) => $(`aria/${label}`),
  testButton: () => $("aria/Test connection"),
  saveButton: () => $("aria/Save & connect"),
  cancelButton: () => $("aria/Cancel"),
  tab: (name: "General" | "SSH tunnel" | "SSL / TLS" | "Advanced") =>
    $(
      `.//*[@role="tablist"][@aria-label="Connection settings"]//*[@role="tab"][normalize-space()="${name}"]`,
    ),
  environment: (env: Environment) => $(`aria/${env[0].toUpperCase()}${env.slice(1)}`),

  async fillNetwork(o: {
    name: string;
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    environment?: Environment;
  }) {
    await this.field("Name").setValue(o.name);
    if (o.environment) await this.environment(o.environment).click();
    await this.field("Host").setValue(o.host);
    await this.field("Port").setValue(String(o.port));
    await this.field("User").setValue(o.user);
    await this.field("Password").setValue(o.password);
    await this.field("Database").setValue(o.database);
  },

  async fillSqlite(o: { name: string; path: string; environment?: Environment }) {
    await this.driver("SQLite").click();
    await this.field("Name").setValue(o.name);
    if (o.environment) await this.environment(o.environment).click();
    await this.field("Database file").setValue(o.path);
  },
};
