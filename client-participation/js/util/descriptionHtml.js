var markdown = require("markdown").markdown;

var SAFE_URL = /^(https?:|mailto:)/i;
var URL_ATTRIBUTES = ["href", "src"];

function isAttributes(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dropUnsafeUrls(node) {
  if (!Array.isArray(node)) {
    return;
  }
  if (isAttributes(node[1])) {
    URL_ATTRIBUTES.forEach(function (name) {
      var url = node[1][name];
      if (typeof url === "string" && !SAFE_URL.test(url.trim())) {
        delete node[1][name];
      }
    });
  }
  node.forEach(dropUnsafeUrls);
}

function descriptionHtml(description) {
  var tree = markdown.toHTMLTree(description || "");
  dropUnsafeUrls(tree);
  return markdown.renderJsonML(tree);
}

module.exports = descriptionHtml;
