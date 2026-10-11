import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import { ClewMark } from "./ClewMark";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

describe("ClewMark", () => {
  it("is named Clew, sized by prop and drawn in currentColor", () => {
    render(<ClewMark size={56} />);
    const mark = screen.getByRole("img", { name: "Clew" });
    expect(mark).toHaveAttribute("width", "56");
    expect(mark).toHaveAttribute("height", "56");
    expect(mark).toHaveAttribute("fill", "currentColor");
  });

  it("gives every instance its own mask id", () => {
    const { container } = render(
      <>
        <ClewMark />
        <ClewMark />
      </>,
    );
    const ids = [...container.querySelectorAll("mask")].map((m) => m.id);
    expect(new Set(ids).size).toBe(2);
  });

  it("is coloured with the accent token where it is placed", () => {
    expect(read("../shell/Toolbar.module.css")).toMatch(/\.brand\s*{[^}]*color:\s*var\(--accent\)/);
    expect(read("../shell/Welcome.module.css")).toMatch(
      /\.identity\s*{[^}]*color:\s*var\(--accent\)/,
    );
  });

  it("is the only place the logo is drawn", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name) && !name.includes("ClewMark")) files.push(path);
      }
    };
    walk(join(process.cwd(), "src"));
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toContain("ClewLogo");
      expect(text, file).not.toContain("M15.5 15.5c2 2 4 3 7 3");
      expect(text, file).not.toContain("M10.4 17.6");
    }
  });
});
