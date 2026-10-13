import {
  applySettings,
  buildUrl,
  draftFromConnection,
  newDraft,
  setEnvironment,
  switchDriver,
  tabOfError,
  toConnection,
  toSaveRequest,
  validate,
} from "./draft";

describe("driver switch", () => {
  it("moves the port to the new driver's default until the port was edited", () => {
    const pg = newDraft("postgres");
    expect(pg.port).toBe("5432");
    expect(switchDriver(pg, "mysql").port).toBe("3306");

    const edited = { ...pg, port: "6000", portEdited: true };
    expect(switchDriver(edited, "mysql").port).toBe("6000");
  });

  it("clears the port for file drivers and fills it back for network drivers", () => {
    const sqlite = switchDriver(newDraft("postgres"), "sqlite");
    expect(sqlite.port).toBe("");
    expect(switchDriver(sqlite, "oracle").port).toBe("1521");
  });
});

describe("name suggestion", () => {
  it("is <env>-<driver> and follows driver and environment changes until edited", () => {
    let d = newDraft("postgres", "production");
    expect(d.name).toBe("prod-postgres");
    d = switchDriver(d, "mysql");
    expect(d.name).toBe("prod-mysql");
    d = setEnvironment(d, "staging");
    expect(d.name).toBe("staging-mysql");
    d = { ...d, name: "Analytics", nameEdited: true };
    expect(setEnvironment(switchDriver(d, "mariadb"), "local").name).toBe("Analytics");
  });
});

describe("safeguards", () => {
  it("are all on for production and all off elsewhere", () => {
    const prod = setEnvironment(newDraft(), "production");
    expect(prod.safeguards).toEqual({
      readOnlyByDefault: true,
      confirmWrites: true,
      manualCommit: true,
    });
    expect(setEnvironment(prod, "local").safeguards).toEqual({
      readOnlyByDefault: false,
      confirmWrites: false,
      manualCommit: false,
    });
  });
});

describe("validation", () => {
  it("flags an empty host and out-of-range ports", () => {
    const d = { ...newDraft(), host: "" };
    expect(validate(d).host).toBeDefined();
    for (const port of ["0", "65536", "abc", ""]) {
      expect(validate({ ...newDraft(), port }).port).toBeDefined();
    }
    expect(validate({ ...newDraft(), port: "65535" }).port).toBeUndefined();
  });

  it("requires a name, a file for file drivers and a URI for MongoDB", () => {
    expect(validate({ ...newDraft(), name: " " }).name).toBeDefined();
    const file = newDraft("sqlite");
    expect(validate(file).filePath).toBeDefined();
    expect(validate(file).host).toBeUndefined();
    expect(validate({ ...file, filePath: "/tmp/a.db" })).toEqual({});
    expect(validate(newDraft("mongodb")).uri).toBeDefined();
  });

  it("checks the SSH tab only when the tunnel is on, and says which tab to open", () => {
    const d = { ...newDraft(), host: "h", sshEnabled: true, sshHost: "" };
    const errors = validate(d);
    expect(errors.sshHost).toBeDefined();
    expect(tabOfError(errors)).toBe("ssh");
    expect(validate({ ...d, sshEnabled: false })).toEqual({});
    expect(tabOfError({ host: "x", sshHost: "y" })).toBe("general");
  });
});

describe("save request", () => {
  it("round-trips a saved connection and keeps secrets out of it", () => {
    const d = {
      ...newDraft("postgres", "production"),
      host: "db.internal",
      database: "analytics",
      user: "karthik",
      password: "s3cret",
      sshEnabled: true,
      sshHost: "bastion",
      sshUser: "tunnel",
      sshAuth: "key" as const,
      sshKeyFile: "~/.ssh/id",
      sshPassphrase: "pp",
      onConnect: "SET a = 1\n\n SET b = 2 ",
      properties: [
        { key: "application_name", value: "clew" },
        { key: " ", value: "x" },
      ],
    };
    const req = toSaveRequest(d);
    expect(req.password).toEqual({ action: "set", value: "s3cret" });
    expect(req.sshPassphrase).toEqual({ action: "set", value: "pp" });
    expect(req.sshPassword).toEqual({ action: "keep" });
    expect(JSON.stringify(req.connection)).not.toMatch(/s3cret|"pp"/);
    expect(req.connection.advanced.onConnect).toEqual(["SET a = 1", "SET b = 2"]);
    expect(req.connection.advanced.properties).toEqual({ application_name: "clew" });

    const back = draftFromConnection({ ...req.connection, id: "c_1" });
    expect(back.id).toBe("c_1");
    expect(back.host).toBe("db.internal");
    expect(back.sshKeyFile).toBe("~/.ssh/id");
    expect(back.password).toBe("");
    expect(toConnection(back)).toEqual({ ...req.connection, id: "c_1" });
  });

  it("keeps a stored password unless the user types a new one or clears it", () => {
    const d = newDraft();
    expect(toSaveRequest(d).password).toEqual({ action: "keep" });
    expect(toSaveRequest({ ...d, clearPassword: true }).password).toEqual({ action: "clear" });
  });
});

describe("URL preview", () => {
  it("builds network URLs without the password", () => {
    const d = {
      ...newDraft("postgres"),
      host: "db.internal",
      user: "karthik",
      password: "topsecret",
      database: "analytics",
      tlsMode: "verify-full" as const,
    };
    const url = buildUrl(d);
    expect(url).toBe("postgres://karthik@db.internal:5432/analytics?sslmode=verify-full");
    expect(url).not.toContain("topsecret");
  });

  it("follows the driver", () => {
    const mysql = { ...switchDriver(newDraft(), "mysql"), host: "h", tlsMode: "require" as const };
    expect(buildUrl(mysql)).toBe("mysql://h:3306?ssl-mode=REQUIRED");
    expect(buildUrl({ ...newDraft("sqlite"), filePath: "/tmp/a.db" })).toBe("sqlite:/tmp/a.db");
    expect(buildUrl({ ...newDraft("redis"), host: "cache", dbIndex: "2" })).toBe(
      "redis://cache:6379/2",
    );
    expect(buildUrl({ ...newDraft("neo4j"), host: "g", protocol: "neo4j+s", user: "neo4j" })).toBe(
      "neo4j+s://neo4j@g:7687",
    );
    expect(
      buildUrl({
        ...newDraft("oracle"),
        host: "db",
        connectBy: "serviceName",
        connectValue: "PDB1",
      }),
    ).toBe("oracle://db:1521/PDB1");
    expect(
      buildUrl({ ...newDraft("oracle"), host: "db", connectBy: "tnsAlias", connectValue: "X" }),
    ).toBeNull();
    expect(buildUrl({ ...newDraft(), host: "" })).toBeNull();
  });

  it("encodes special characters in user names", () => {
    expect(buildUrl({ ...newDraft(), host: "h", user: "we@ird" })).toBe(
      "postgres://we%40ird@h:5432",
    );
  });
});

describe("Neo4j URLs", () => {
  it.each(["neo4j", "neo4j+s", "bolt", "bolt+s"])(
    "fills the form from a parsed %s:// URL and builds it back",
    (protocol) => {
      const draft = applySettings(newDraft("neo4j"), {
        kind: "neo4j",
        protocol,
        host: "graph.internal",
        port: 7688,
        user: "karthik",
        database: "movies",
        passwordMode: "keychain",
      });
      expect(draft).toMatchObject({
        protocol,
        host: "graph.internal",
        port: "7688",
        database: "movies",
      });
      expect(buildUrl(draft)).toBe(`${protocol}://karthik@graph.internal:7688/movies`);
      expect(toConnection(draft).settings).toMatchObject({ kind: "neo4j", protocol, port: 7688 });
    },
  );

  it("defaults to port 7687 and the neo4j protocol", () => {
    const d = newDraft("neo4j");
    expect(d).toMatchObject({ port: "7687", protocol: "neo4j" });
    expect(validate({ ...d, host: "h" })).toEqual({});
  });
});
