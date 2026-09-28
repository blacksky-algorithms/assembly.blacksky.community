var test = require("node:test");
var assert = require("node:assert/strict");
var descriptionHtml = require("./descriptionHtml");

function assertRenders(rows) {
  rows.forEach(function (row) {
    assert.equal(descriptionHtml(row.description), row.html);
  });
}

test("links keep web and mail addresses and lose every other address", function () {
  assertRenders([
    {
      description: "**bold** and *em* and [link](https://example.com)",
      html: '<p><strong>bold</strong> and <em>em</em> and <a href="https://example.com">link</a></p>'
    },
    {
      description: "[mail](mailto:someone@example.com) and [plain](http://example.com/a?b=c)",
      html: '<p><a href="mailto:someone@example.com">mail</a> and <a href="http://example.com/a?b=c">plain</a></p>'
    },
    { description: "<https://example.com>", html: '<p><a href="https://example.com">https://example.com</a></p>' },
    { description: "[click](javascript:alert(1))", html: "<p><a>click</a></p>" },
    { description: '[click](javascript:alert(1) "title")', html: '<p><a title="title">click</a></p>' },
    { description: "[a](data:text/html;base64,PHNjcmlwdD4=)", html: "<p><a>a</a></p>" },
    { description: "[a](  JaVaScRiPt:alert(1))", html: "<p><a>a</a></p>" },
    { description: "[a](vbscript:msgbox(1))", html: "<p><a>a</a></p>" },
    { description: "[a](java\tscript:alert(1))", html: "<p><a>a</a></p>" },
    { description: "[a](/relative/path)", html: "<p><a>a</a></p>" },
    { description: "[a](example.com)", html: "<p><a>a</a></p>" }
  ]);
});

test("reference links follow the same rule", function () {
  assertRenders([
    { description: "[x]: https://example.com/page\n\n[x]", html: '<p><a href="https://example.com/page">x</a></p>' },
    { description: "[x]: javascript:alert(1)\n\n[x]", html: "<p><a>x</a></p>" }
  ]);
});

test("images keep web sources and lose every other source", function () {
  assertRenders([
    {
      description: '![x](https://example.com/a.png "T")',
      html: '<p><img alt="x" title="T" src="https://example.com/a.png"/></p>'
    },
    { description: "![x](javascript:alert(1))", html: '<p><img alt="x"/>)</p>' }
  ]);
});

test("formatting and escaped markup stay as they are around a removed address", function () {
  assertRenders([
    {
      description: "**bold** <img src=x onerror=alert(1)> [click](javascript:alert(1))",
      html: "<p><strong>bold</strong> &lt;img src=x onerror=alert(1)&gt; <a>click</a></p>"
    },
    {
      description: "# Heading\n\n* one\n* two\n\n[click](javascript:alert(1))",
      html: "<h1>Heading</h1>\n\n<ul><li>one</li><li>two</li></ul>\n\n<p><a>click</a></p>"
    },
    { description: "<img src=x onerror=alert(1)>", html: "<p>&lt;img src=x onerror=alert(1)&gt;</p>" },
    { description: "", html: "" },
    { description: undefined, html: "" }
  ]);
});
