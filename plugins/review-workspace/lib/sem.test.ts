import { describe, expect, it } from "vitest";
import {
  buildSemStdinPayload,
  parseSemJson,
  resetSemBinaryPath,
  semBinaryPath,
} from "./sem";

describe("buildSemStdinPayload", () => {
  it("maps stored contents to sem's stdin schema", () => {
    const payload = JSON.parse(
      buildSemStdinPayload([
        {
          filePath: "src/a.ts",
          beforeContent: "old\n",
          afterContent: "new\n",
        },
        { filePath: "src/b.ts", beforeContent: "gone\n", afterContent: null },
        { filePath: "src/c.ts", beforeContent: null, afterContent: "new file" },
      ]),
    ) as Array<Record<string, unknown>>;
    expect(payload).toEqual([
      {
        filePath: "src/a.ts",
        status: "modified",
        beforeContent: "old\n",
        afterContent: "new\n",
      },
      {
        filePath: "src/b.ts",
        status: "deleted",
        beforeContent: "gone\n",
        afterContent: undefined,
      },
      {
        filePath: "src/c.ts",
        status: "added",
        beforeContent: undefined,
        afterContent: "new file",
      },
    ]);
  });
});

describe("parseSemJson", () => {
  it("parses clean JSON", () => {
    const parsed = parseSemJson(
      JSON.stringify({
        summary: {},
        changes: [
          {
            entityId: "src/a.ts::function::f",
            changeType: "modified",
            entityType: "function",
            entityName: "f",
            startLine: 5,
            endLine: 7,
            oldStartLine: 5,
            oldEndLine: 7,
            filePath: "src/a.ts",
            structuralChange: true,
          },
        ],
      }),
    );
    expect(parsed.changes).toHaveLength(1);
    expect(parsed.changes[0]).toMatchObject({
      entityId: "src/a.ts::function::f",
      changeType: "modified",
      structuralChange: true,
    });
  });

  it("skips before-the-JSON telemetry notices", () => {
    const parsed = parseSemJson(
      'sem keeps anonymous usage stats (command names only)... {"summary":{},"changes":[]}',
    );
    expect(parsed.changes).toEqual([]);
  });

  it("coerces null line info and unknown change types", () => {
    const parsed = parseSemJson(
      JSON.stringify({
        changes: [
          {
            entityId: "src/a.ts::x",
            changeType: "futureBucket",
            entityType: "x",
            entityName: "x",
            startLine: null,
            endLine: null,
            filePath: "src/a.ts",
          },
        ],
      }),
    );
    expect(parsed.changes[0]).toMatchObject({
      changeType: "modified",
      startLine: null,
      endLine: null,
      structuralChange: null,
    });
  });
});

describe("semBinaryPath", () => {
  it("prefers the SEM_BIN_PATH override", () => {
    process.env.SEM_BIN_PATH = "package.json";
    resetSemBinaryPath();
    expect(semBinaryPath()).toBe("package.json");
  });
});
