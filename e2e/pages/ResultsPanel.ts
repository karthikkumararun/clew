import { $, $$ } from "@wdio/globals";

export const ResultsPanel = {
  panel: () => $("aria/Query results"),
  resultTabs: () => $$('[aria-label="Result sets"] [role="tab"]'),
};
