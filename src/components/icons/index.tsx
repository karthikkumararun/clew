import { makeIcon } from "./Icon";
import type { IconProps } from "./Icon";

export type { IconProps };

// Paths are copied from design/canvas/Main.dc.html, Welcome.dc.html and AIProviders.dc.html.
export const ChevronDown = makeIcon(<path d="M4 6l4 4 4-4" />, { strokeWidth: 1.6 });
export const ChevronRight = makeIcon(<path d="M6 4l4 4-4 4" />, { strokeWidth: 1.6 });
export const ChevronUp = makeIcon(<path d="M4 10l4-4 4 4" />);
export const Plus = makeIcon(<path d="M8 3v10M3 8h10" />, { strokeWidth: 1.6 });
export const Close = makeIcon(<path d="M4 4l8 8M12 4l-8 8" />, { strokeWidth: 1.8 });
export const Search = makeIcon(
  <>
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5l3 3" />
  </>,
  { strokeWidth: 1.6 },
);
export const Refresh = makeIcon(<path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5v3h-3" />);
export const Database = makeIcon(
  <>
    <path d="M3 4c0-1.1 2.2-2 5-2s5 .9 5 2v8c0 1.1-2.2 2-5 2s-5-.9-5-2z" />
    <path d="M3 4c0 1.1 2.2 2 5 2s5-.9 5-2M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" />
  </>,
  { strokeWidth: 1.3 },
);
export const Table = makeIcon(
  <>
    <rect x="2" y="3" width="12" height="10" rx="1" />
    <path d="M2 7h12M6 7v6" />
  </>,
  { strokeWidth: 1.3 },
);
export const Folder = makeIcon(<path d="M2 4.5h4l1.5 1.5H14v6.5H2z" />, { strokeWidth: 1.3 });
export const Key = makeIcon(
  <>
    <circle cx="5" cy="8" r="2.5" />
    <path d="M7.5 8H14M12 8v2" />
  </>,
  { strokeWidth: 1.4 },
);
export const Link = makeIcon(<path d="M3 8h8M8 5l3 3-3 3" />, { strokeWidth: 1.4 });
export const Play = makeIcon(<path d="M4 2.5l9 5.5-9 5.5z" fill="currentColor" stroke="none" />);
export const Filter = makeIcon(<path d="M2 3h12l-4.5 5.5V13l-3-1.5v-3z" />, { strokeWidth: 1.4 });
export const Download = makeIcon(<path d="M8 2v8M4.5 7L8 10.5 11.5 7M3 13h10" />);
export const Terminal = makeIcon(<path d="M3 4l3 4-3 4M8 12h5" />);
export const Settings = makeIcon(
  <>
    <circle cx="8" cy="8" r="2.2" />
    <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
  </>,
  { strokeWidth: 1.4 },
);
export const Warning = makeIcon(
  <>
    <path d="M8 2l6.5 11.5h-13z" />
    <path d="M8 6.5v3.2M8 11.6v.2" />
  </>,
  { strokeWidth: 1.4 },
);
export const Check = makeIcon(<path d="M3 8.5l3 3 7-7" />, { strokeWidth: 1.8 });
export const Clock = makeIcon(
  <>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 5v3.2l2 1.3" />
  </>,
  { strokeWidth: 1.4 },
);
export const File = makeIcon(
  <>
    <path d="M4 2h6l3 3v9H4z" />
    <path d="M10 2v3h3" />
  </>,
  { strokeWidth: 1.4 },
);
export const Import = makeIcon(<path d="M2 5h12v8H2zM5 5V3h6v2" />, { strokeWidth: 1.4 });
export const Lines = makeIcon(<path d="M3 4h10M3 8h10M3 12h6" />, { strokeWidth: 1.6 });
export const PanelRight = makeIcon(
  <>
    <rect x="2" y="3" width="12" height="10" rx="1.5" />
    <path d="M10 3v10" />
  </>,
  { strokeWidth: 1.4 },
);
export const Star = makeIcon(
  <path d="M8 1.5l1.6 4.2 4.4.3-3.4 2.8 1.1 4.3L8 10.7l-3.7 2.4 1.1-4.3L2 6l4.4-.3z" />,
  { strokeWidth: 1.4 },
);
