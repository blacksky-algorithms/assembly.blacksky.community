var test = require("node:test");
var assert = require("node:assert/strict");
var addProtocolToLinkIfNeeded = require("./linkProtocol");

test("a link gets the web protocol unless it starts with one", function () {
  [
    { link: "https://example.com", href: "https://example.com" },
    { link: "http://example.com/a?b=c", href: "http://example.com/a?b=c" },
    { link: "HTTPS://EXAMPLE.COM", href: "HTTPS://EXAMPLE.COM" },
    { link: "example.com", href: "http://example.com" },
    { link: "javascript:alert(1)//http://x", href: "http://javascript:alert(1)//http://x" },
    { link: "JaVaScRiPt:alert(1)//https://x", href: "http://JaVaScRiPt:alert(1)//https://x" },
    { link: "data:text/html,x//https://x", href: "http://data:text/html,x//https://x" },
    { link: " https://example.com", href: "http:// https://example.com" },
    { link: "", href: "" },
    { link: undefined, href: undefined }
  ].forEach(function (row) {
    assert.equal(addProtocolToLinkIfNeeded(row.link), row.href);
  });
});
