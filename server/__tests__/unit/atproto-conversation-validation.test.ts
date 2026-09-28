import { createHash } from "node:crypto";
import { afterEach, describe, expect, jest, test } from "@jest/globals";
import {
  ATPROTO_CONVERSATION_LIMITS,
  ATPROTO_CREATE_CONVERSATION_LXM,
  AtprotoConversationError,
  getAtprotoConversationRef,
  getAtprotoStatements,
  hashAtprotoConversationContent,
  isAtprotoRecordCid,
  requireAtprotoCreateEnabled,
  validateAtprotoConversationInput,
} from "../../src/routes/atproto-conversations";

const DID = "did:plc:abcdefghijklmnopqrstuvwx";
const OTHER_DID = "did:plc:zyxwvutsrqponmlkjihgfedc";
const COLLECTION = "community.blacksky.assembly.conversation";
const AT_URI = `at://${DID}/${COLLECTION}/3jzfcijpj2z2a`;
const AT_CID = "bafyreidfayvfuwqa7qlnopdjiqrxzs6blmoeu4rujcjtnci5beludirz2a";
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

const THUMB = "\u{1F44D}\u{1F3FD}";
const STACKED_E = "\u00e9\u0302";
const LONG_MARK = "\u20d0";
const ACUTE = "\u0301";

function encodeBase32(bytes: Uint8Array): string {
  let value = 0;
  let bits = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(value >> bits) & 31];
      value &= (1 << bits) - 1;
    }
  }
  if (bits > 0) {
    out += BASE32[(value << (5 - bits)) & 31];
  }
  return out;
}

function buildCid(seed: string, prefix = [0x01, 0x71, 0x12, 0x20]): string {
  const digest = createHash("sha256").update(seed).digest();
  return `b${encodeBase32(Buffer.concat([Buffer.from(prefix), digest]))}`;
}

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    topic: "Should the library open on Sundays?",
    statements: ["Yes, all day", "Only in the afternoon"],
    conversation: { at_uri: AT_URI, at_cid: AT_CID },
    ...overrides,
  };
}

function failure(
  input: Record<string, unknown>,
  did = DID
): { name: string; code: string; status: number; message: string } {
  try {
    validateAtprotoConversationInput(input, did);
  } catch (err) {
    expect(err).toBeInstanceOf(AtprotoConversationError);
    const { name, code, status, message } = err as AtprotoConversationError;
    return { name, code, status, message };
  }
  throw new Error("the input was accepted");
}

function rejection(code: string, status = 400) {
  return { name: "AtprotoConversationError", code, status, message: code };
}

describe("constants", () => {
  test("names the method and the limits", () => {
    expect(ATPROTO_CREATE_CONVERSATION_LXM).toBe(
      "community.blacksky.assembly.createConversation"
    );
    expect(ATPROTO_CONVERSATION_LIMITS).toEqual({
      topicGraphemes: 200,
      topicBytes: 1000,
      statements: 10,
      statementGraphemes: 400,
      statementBytes: 2000,
      statementCodeUnits: 997,
    });
  });
});

describe("validateAtprotoConversationInput", () => {
  test("returns the normalised content and the record reference", () => {
    expect(validateAtprotoConversationInput(validInput(), DID)).toEqual({
      topic: "Should the library open on Sundays?",
      statements: ["Yes, all day", "Only in the afternoon"],
      atUri: AT_URI,
      atCid: AT_CID,
    });
  });

  test("trims and composes the topic and the statements", () => {
    const result = validateAtprotoConversationInput(
      validInput({
        topic: " \t\n Cafe\u0301 hours \u00a0\n",
        statements: [
          "\n  Open late  ",
          "\u2003Cre\u0300me bru\u0302le\u0301e ",
        ],
      }),
      DID
    );

    expect(result.topic).toBe("Caf\u00e9 hours");
    expect(result.statements).toEqual([
      "Open late",
      "Cr\u00e8me br\u00fbl\u00e9e",
    ]);
  });

  test("ignores a description and any other field", () => {
    const result = validateAtprotoConversationInput(
      validInput({ description: "<script>", owner: 1, is_active: false }),
      DID
    );

    expect(Object.keys(result).sort()).toEqual([
      "atCid",
      "atUri",
      "statements",
      "topic",
    ]);
  });

  describe("topic", () => {
    test.each([
      ["a missing topic", undefined],
      ["null", null],
      ["a number", 42],
      ["an array", ["topic"]],
      ["an empty string", ""],
      ["spaces only", "   "],
      ["line breaks and tabs only", "\n\t\r\n"],
      ["a no-break space only", "\u00a0"],
    ])("rejects %s", (label, topic) => {
      expect(failure(validInput({ topic }))).toEqual(
        rejection("polis_err_atproto_conversation_topic_empty")
      );
    });

    test("accepts one character", () => {
      expect(
        validateAtprotoConversationInput(validInput({ topic: "a" }), DID).topic
      ).toBe("a");
    });

    test("accepts 200 graphemes and rejects 201", () => {
      const accepted = "a".repeat(200);

      expect(
        validateAtprotoConversationInput(validInput({ topic: accepted }), DID)
          .topic
      ).toBe(accepted);
      expect(failure(validInput({ topic: "a".repeat(201) }))).toEqual(
        rejection("polis_err_atproto_conversation_topic_too_long")
      );
    });

    test("counts graphemes, not code points", () => {
      const accepted = STACKED_E.repeat(200);
      expect([...accepted]).toHaveLength(400);
      expect(Buffer.byteLength(accepted, "utf8")).toBe(800);

      expect(
        validateAtprotoConversationInput(validInput({ topic: accepted }), DID)
          .topic
      ).toBe(accepted);

      const rejected = STACKED_E.repeat(201);
      expect(Buffer.byteLength(rejected, "utf8")).toBe(804);
      expect(failure(validInput({ topic: rejected }))).toEqual(
        rejection("polis_err_atproto_conversation_topic_too_long")
      );
    });

    test("accepts 1000 bytes and rejects 1001", () => {
      const accepted = THUMB.repeat(125);
      expect(Buffer.byteLength(accepted, "utf8")).toBe(1000);

      expect(
        validateAtprotoConversationInput(validInput({ topic: accepted }), DID)
          .topic
      ).toBe(accepted);

      const rejected = `${accepted}a`;
      expect(Buffer.byteLength(rejected, "utf8")).toBe(1001);
      expect(failure(validInput({ topic: rejected }))).toEqual(
        rejection("polis_err_atproto_conversation_topic_too_long")
      );
    });

    test("measures the topic after trimming", () => {
      const topic = `   ${"a".repeat(200)}   `;

      expect(
        validateAtprotoConversationInput(validInput({ topic }), DID).topic
      ).toBe("a".repeat(200));
    });

    test.each([
      ["a NUL character", "before\u0000after"],
      ["a NUL character at the end", "topic\u0000"],
      ["an unpaired high surrogate", "before\ud83dafter"],
      ["an unpaired low surrogate", "before\udc4dafter"],
    ])("rejects %s", (label, topic) => {
      expect(failure(validInput({ topic }))).toEqual(
        rejection("polis_err_atproto_conversation_text_invalid")
      );
    });

    test("accepts a paired surrogate", () => {
      expect(
        validateAtprotoConversationInput(
          validInput({ topic: "\ud83d\udc4d" }),
          DID
        ).topic
      ).toBe("\u{1F44D}");
    });
  });

  describe("statements", () => {
    test.each([
      ["missing statements", undefined],
      ["null", null],
      ["a string", "One"],
      ["an object", { 0: "One", length: 1 }],
      ["an empty list", []],
      [
        "eleven statements",
        Array.from(Array(11).keys(), (index) => `Statement ${index}`),
      ],
    ])("rejects %s", (label, statements) => {
      expect(failure(validInput({ statements }))).toEqual(
        rejection("polis_err_atproto_conversation_statements_count")
      );
    });

    test("accepts one statement", () => {
      expect(
        validateAtprotoConversationInput(
          validInput({ statements: ["Only one"] }),
          DID
        ).statements
      ).toEqual(["Only one"]);
    });

    test("accepts ten statements and keeps their order", () => {
      const statements = Array.from(
        Array(10).keys(),
        (index) => `Statement ${9 - index}`
      );

      expect(
        validateAtprotoConversationInput(validInput({ statements }), DID)
          .statements
      ).toEqual([
        "Statement 9",
        "Statement 8",
        "Statement 7",
        "Statement 6",
        "Statement 5",
        "Statement 4",
        "Statement 3",
        "Statement 2",
        "Statement 1",
        "Statement 0",
      ]);
    });

    test.each([
      ["an empty string", ""],
      ["spaces only", "    "],
      ["line breaks only", "\n\n"],
      ["a number", 7],
      ["null", null],
      ["a nested list", ["One"]],
    ])("rejects a statement that is %s", (label, statement) => {
      expect(failure(validInput({ statements: ["First", statement] }))).toEqual(
        rejection("polis_err_atproto_conversation_statement_empty")
      );
    });

    test("accepts 400 graphemes and rejects 401", () => {
      const accepted = "a".repeat(400);

      expect(
        validateAtprotoConversationInput(
          validInput({ statements: [accepted] }),
          DID
        ).statements
      ).toEqual([accepted]);
      expect(failure(validInput({ statements: ["a".repeat(401)] }))).toEqual(
        rejection("polis_err_atproto_conversation_statement_too_long")
      );
    });

    test("counts graphemes, not code points", () => {
      const accepted = STACKED_E.repeat(400);
      expect([...accepted]).toHaveLength(800);
      expect(Buffer.byteLength(accepted, "utf8")).toBe(1600);

      expect(
        validateAtprotoConversationInput(
          validInput({ statements: [accepted] }),
          DID
        ).statements
      ).toEqual([accepted]);

      const rejected = STACKED_E.repeat(401);
      expect(rejected).toHaveLength(802);
      expect(Buffer.byteLength(rejected, "utf8")).toBe(1604);
      expect(failure(validInput({ statements: [rejected] }))).toEqual(
        rejection("polis_err_atproto_conversation_statement_too_long")
      );
    });

    test("accepts 2000 bytes and rejects 2001", () => {
      const block = `\u65e5${LONG_MARK.repeat(665)}`;
      const accepted = `${block}ab`;
      expect(Buffer.byteLength(accepted, "utf8")).toBe(2000);
      expect(accepted).toHaveLength(668);

      expect(
        validateAtprotoConversationInput(
          validInput({ statements: [accepted] }),
          DID
        ).statements
      ).toEqual([accepted]);

      const rejected = `${block}abc`;
      expect(Buffer.byteLength(rejected, "utf8")).toBe(2001);
      expect(rejected).toHaveLength(669);
      expect(failure(validInput({ statements: [rejected] }))).toEqual(
        rejection("polis_err_atproto_conversation_statement_too_long")
      );
    });

    test("accepts 997 code units and rejects 998", () => {
      const accepted = `q${ACUTE.repeat(996)}`;
      expect(accepted).toHaveLength(997);
      expect(Buffer.byteLength(accepted, "utf8")).toBe(1993);

      expect(
        validateAtprotoConversationInput(
          validInput({ statements: [accepted] }),
          DID
        ).statements
      ).toEqual([accepted]);

      const rejected = `q${ACUTE.repeat(997)}`;
      expect(rejected).toHaveLength(998);
      expect(Buffer.byteLength(rejected, "utf8")).toBe(1995);
      expect(failure(validInput({ statements: [rejected] }))).toEqual(
        rejection("polis_err_atproto_conversation_statement_too_long")
      );
    });

    test("applies the limits to every statement", () => {
      expect(
        failure(validInput({ statements: ["Short", "a".repeat(401)] }))
      ).toEqual(rejection("polis_err_atproto_conversation_statement_too_long"));
    });

    test.each([
      ["a NUL character", "before\u0000after"],
      ["an unpaired high surrogate", "before\ud83dafter"],
      ["an unpaired low surrogate", "\udc4d"],
    ])("rejects a statement with %s", (label, statement) => {
      expect(failure(validInput({ statements: ["First", statement] }))).toEqual(
        rejection("polis_err_atproto_conversation_text_invalid")
      );
    });

    test.each([
      ["identical", ["Same", "Other", "Same"]],
      ["identical after trimming", ["Same", "  Same\n"]],
      ["identical after composing", ["Cafe\u0301", "Caf\u00e9"]],
      ["different only in case", ["Open Late", "open late"]],
      [
        "different only in the case of an accent",
        ["\u00c9cole", "e\u0301cole"],
      ],
    ])("rejects statements that are %s", (label, statements) => {
      expect(failure(validInput({ statements }))).toEqual(
        rejection("polis_err_atproto_conversation_statement_duplicate")
      );
    });

    test("accepts statements that differ in spacing or punctuation", () => {
      const statements = ["Open late", "Open  late", "Open late!"];

      expect(
        validateAtprotoConversationInput(validInput({ statements }), DID)
          .statements
      ).toEqual(statements);
    });

    test("accepts a statement equal to the topic", () => {
      const result = validateAtprotoConversationInput(
        validInput({ topic: "Same text", statements: ["Same text"] }),
        DID
      );

      expect(result.topic).toBe("Same text");
      expect(result.statements).toEqual(["Same text"]);
    });
  });

  describe("conversation reference", () => {
    test.each([
      ["a missing reference", undefined],
      ["null", null],
      ["a string", AT_URI],
      ["an empty object", {}],
      ["a missing at_uri", { at_cid: AT_CID }],
      ["a numeric at_uri", { at_uri: 5, at_cid: AT_CID }],
    ])("rejects %s", (label, conversation) => {
      expect(failure(validInput({ conversation }))).toEqual(
        rejection("polis_err_atproto_record_uri_invalid")
      );
    });

    test.each([
      ["another collection", `at://${DID}/app.bsky.feed.post/3jzfcijpj2z2a`],
      [
        "the statement collection",
        `at://${DID}/community.blacksky.assembly.statement/3jzfcijpj2z2a`,
      ],
      ["a handle as authority", `at://alice.test/${COLLECTION}/3jzfcijpj2z2a`],
      ["no record key", `at://${DID}/${COLLECTION}`],
      ["an empty record key", `at://${DID}/${COLLECTION}/`],
      ["the record key .", `at://${DID}/${COLLECTION}/.`],
      ["the record key ..", `at://${DID}/${COLLECTION}/..`],
      ["a slash in the record key", `at://${DID}/${COLLECTION}/a/b`],
      ["a space in the record key", `at://${DID}/${COLLECTION}/a b`],
      ["a fragment", `at://${DID}/${COLLECTION}/3jzfcijpj2z2a#frag`],
      ["a query", `at://${DID}/${COLLECTION}/3jzfcijpj2z2a?x=1`],
      ["a trailing line break", `${AT_URI}\n`],
      ["leading space", ` ${AT_URI}`],
      ["the https scheme", `https://${DID}/${COLLECTION}/3jzfcijpj2z2a`],
      ["an upper case scheme", `AT://${DID}/${COLLECTION}/3jzfcijpj2z2a`],
      [
        "a record key of 513 characters",
        `at://${DID}/${COLLECTION}/${"a".repeat(513)}`,
      ],
      ["an empty string", ""],
    ])("rejects an at_uri with %s", (label, at_uri) => {
      expect(
        failure(validInput({ conversation: { at_uri, at_cid: AT_CID } }))
      ).toEqual(rejection("polis_err_atproto_record_uri_invalid"));
    });

    test.each([
      ["a record key of 512 characters", "a".repeat(512)],
      ["every allowed record key character", "Az09.-_:~"],
      ["the record key self", "self"],
      ["three dots", "..."],
    ])("accepts %s", (label, rkey) => {
      const at_uri = `at://${DID}/${COLLECTION}/${rkey}`;

      expect(
        validateAtprotoConversationInput(
          validInput({ conversation: { at_uri, at_cid: AT_CID } }),
          DID
        ).atUri
      ).toBe(at_uri);
    });

    test("answers 403 when the record is in another repository", () => {
      expect(
        failure(
          validInput({
            conversation: {
              at_uri: `at://${OTHER_DID}/${COLLECTION}/3jzfcijpj2z2a`,
              at_cid: AT_CID,
            },
          })
        )
      ).toEqual(rejection("polis_err_atproto_record_did_mismatch", 403));
    });

    test("compares the repository with the given issuer", () => {
      expect(failure(validInput(), OTHER_DID)).toEqual(
        rejection("polis_err_atproto_record_did_mismatch", 403)
      );
    });

    test("compares the repository exactly", () => {
      expect(
        failure(
          validInput({
            conversation: {
              at_uri: `at://${DID.toUpperCase().replace(
                "DID:PLC",
                "did:plc"
              )}/${COLLECTION}/3jzfcijpj2z2a`,
              at_cid: AT_CID,
            },
          })
        )
      ).toEqual(rejection("polis_err_atproto_record_did_mismatch", 403));
    });

    test.each([
      ["a missing at_cid", undefined],
      ["null", null],
      ["a number", 12],
      ["an empty string", ""],
      ["a CIDv0", "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"],
      ["the raw codec", buildCid("raw", [0x01, 0x55, 0x12, 0x20])],
      ["a sha-512 digest prefix", buildCid("sha512", [0x01, 0x71, 0x13, 0x20])],
      ["upper case", AT_CID.toUpperCase()],
      ["one character short", AT_CID.slice(0, -1)],
      ["one character long", `${AT_CID}a`],
      ["padding bits set", `${AT_CID.slice(0, -1)}b`],
      ["the digit 1", `${AT_CID.slice(0, 20)}1${AT_CID.slice(21)}`],
      ["a trailing line break", `${AT_CID}\n`],
      ["a multibase prefix other than b", `z${AT_CID.slice(1)}`],
    ])("rejects an at_cid that is %s", (label, at_cid) => {
      expect(
        failure(validInput({ conversation: { at_uri: AT_URI, at_cid } }))
      ).toEqual(rejection("polis_err_atproto_record_cid_invalid"));
    });

    test("accepts generated record CIDs", () => {
      for (let index = 0; index < 64; index++) {
        const at_cid = buildCid(`record ${index}`);

        expect(
          validateAtprotoConversationInput(
            validInput({ conversation: { at_uri: AT_URI, at_cid } }),
            DID
          ).atCid
        ).toBe(at_cid);
      }
    });
  });

  describe("order of the checks", () => {
    test("reports the topic before the statements", () => {
      expect(failure(validInput({ topic: "", statements: [] }))).toEqual(
        rejection("polis_err_atproto_conversation_topic_empty")
      );
    });

    test("reports the statements before the reference", () => {
      expect(failure(validInput({ statements: [], conversation: {} }))).toEqual(
        rejection("polis_err_atproto_conversation_statements_count")
      );
    });

    test("reports the at_uri before the at_cid", () => {
      expect(
        failure(
          validInput({
            conversation: {
              at_uri: `at://${OTHER_DID}/${COLLECTION}/3jzfcijpj2z2a`,
              at_cid: "not-a-cid",
            },
          })
        )
      ).toEqual(rejection("polis_err_atproto_record_did_mismatch", 403));
    });
  });
});

describe("isAtprotoRecordCid", () => {
  test("accepts a record CID", () => {
    expect(isAtprotoRecordCid(AT_CID)).toBe(true);
    expect(isAtprotoRecordCid(buildCid("another record"))).toBe(true);
  });

  test("rejects other values", () => {
    expect(isAtprotoRecordCid(buildCid("raw", [0x01, 0x55, 0x12, 0x20]))).toBe(
      false
    );
    expect(isAtprotoRecordCid("bafyembedtest")).toBe(false);
    expect(isAtprotoRecordCid(undefined)).toBe(false);
  });
});

describe("hashAtprotoConversationContent", () => {
  test("is the sha256 of the topic and the statements as JSON", () => {
    expect(hashAtprotoConversationContent("Topic", ["One", "Two"])).toBe(
      "77b2ac8ed8183a93e5a7316a742efb00f9a70fc37dae00bcb7e14cede86cbfdf"
    );
  });

  test("changes with the order of the statements", () => {
    expect(hashAtprotoConversationContent("Topic", ["Two", "One"])).not.toBe(
      "77b2ac8ed8183a93e5a7316a742efb00f9a70fc37dae00bcb7e14cede86cbfdf"
    );
  });

  test("keeps the topic and the statements apart", () => {
    const hashes = [
      hashAtprotoConversationContent("ab", ["c"]),
      hashAtprotoConversationContent("a", ["bc"]),
      hashAtprotoConversationContent("a", ["b", "c"]),
      hashAtprotoConversationContent('a","statements":["b', ["c"]),
    ];

    expect(new Set(hashes).size).toBe(4);
    for (const hash of hashes) {
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe("getAtprotoStatements", () => {
  test("passes a list of strings through unchanged", async () => {
    await expect(getAtprotoStatements(["  One ", "", "Two"])).resolves.toEqual([
      "  One ",
      "",
      "Two",
    ]);
    await expect(getAtprotoStatements([])).resolves.toEqual([]);
  });

  test("accepts 100 entries of 4000 characters", async () => {
    const statements = Array.from({ length: 100 }, () => "a".repeat(4000));

    await expect(getAtprotoStatements(statements)).resolves.toBe(statements);
  });

  test.each([
    ["a string", "One,Two", "polis_fail_parse_statements_not_array"],
    ["an object", { 0: "One" }, "polis_fail_parse_statements_not_array"],
    ["a number", 3, "polis_fail_parse_statements_not_array"],
    [
      "101 entries",
      Array.from({ length: 101 }, () => "a"),
      "polis_fail_parse_statements_too_many",
    ],
    ["a number entry", ["One", 2], "polis_fail_parse_statement_not_string"],
    ["a null entry", [null], "polis_fail_parse_statement_not_string"],
    ["an object entry", [{}], "polis_fail_parse_statement_not_string"],
    [
      "an entry of 4001 characters",
      ["a".repeat(4001)],
      "polis_fail_parse_statement_too_long",
    ],
  ])("rejects %s", async (label, value, reason) => {
    await expect(getAtprotoStatements(value)).rejects.toBe(reason);
  });
});

describe("getAtprotoConversationRef", () => {
  test("returns only at_uri and at_cid", async () => {
    await expect(
      getAtprotoConversationRef({
        at_uri: AT_URI,
        at_cid: AT_CID,
        extra: "ignored",
      })
    ).resolves.toEqual({ at_uri: AT_URI, at_cid: AT_CID });
  });

  test("accepts an at_uri of 1024 and an at_cid of 200 characters", async () => {
    const ref = { at_uri: "a".repeat(1024), at_cid: "b".repeat(200) };

    await expect(getAtprotoConversationRef(ref)).resolves.toEqual(ref);
  });

  test.each([
    ["a string", AT_URI, "polis_fail_parse_conversation_not_object"],
    ["null", null, "polis_fail_parse_conversation_not_object"],
    ["a list", [AT_URI, AT_CID], "polis_fail_parse_conversation_not_object"],
    [
      "a missing at_cid",
      { at_uri: AT_URI },
      "polis_fail_parse_conversation_ref_missing",
    ],
    [
      "a missing at_uri",
      { at_cid: AT_CID },
      "polis_fail_parse_conversation_ref_missing",
    ],
    [
      "a numeric at_cid",
      { at_uri: AT_URI, at_cid: 1 },
      "polis_fail_parse_conversation_ref_missing",
    ],
    [
      "an at_uri of 1025 characters",
      { at_uri: "a".repeat(1025), at_cid: AT_CID },
      "polis_fail_parse_conversation_ref_too_long",
    ],
    [
      "an at_cid of 201 characters",
      { at_uri: AT_URI, at_cid: "b".repeat(201) },
      "polis_fail_parse_conversation_ref_too_long",
    ],
  ])("rejects %s", async (label, value, reason) => {
    await expect(getAtprotoConversationRef(value)).rejects.toBe(reason);
  });
});

describe("requireAtprotoCreateEnabled", () => {
  const original = process.env.ATPROTO_APP_CREATE_ENABLED;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.ATPROTO_APP_CREATE_ENABLED;
    } else {
      process.env.ATPROTO_APP_CREATE_ENABLED = original;
    }
  });

  function run() {
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    const next = jest.fn();
    requireAtprotoCreateEnabled({}, { status }, next);
    return { json, status, next };
  }

  test.each([
    ["unset", undefined],
    ["empty", ""],
    ["false", "false"],
    ["0", "0"],
  ])("answers 503 when the setting is %s", (label, value) => {
    if (value === undefined) {
      delete process.env.ATPROTO_APP_CREATE_ENABLED;
    } else {
      process.env.ATPROTO_APP_CREATE_ENABLED = value;
    }

    const { json, status, next } = run();

    expect(next).not.toHaveBeenCalled();
    expect(status.mock.calls).toEqual([[503]]);
    expect(json.mock.calls).toEqual([
      [
        {
          error: "polis_err_atproto_conversations_disabled",
          message: "polis_err_atproto_conversations_disabled",
          status: 503,
        },
      ],
    ]);
  });

  test("continues when the setting is true", () => {
    process.env.ATPROTO_APP_CREATE_ENABLED = "true";

    const { json, status, next } = run();

    expect(next.mock.calls).toEqual([[]]);
    expect(status).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });
});
