function addProtocolToLinkIfNeeded(url) {
  if (!url) {
    return url;
  } else if (/^https?:\/\//i.test(url)) {
    return url;
  } else {
    return "http://" + url;
  }
}

module.exports = addProtocolToLinkIfNeeded;
