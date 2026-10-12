import { $ } from "@wdio/globals";

export const Welcome = {
  newConnection: () => $("aria/New connection"),
  urlField: () => $("aria/Connection URL"),
};
