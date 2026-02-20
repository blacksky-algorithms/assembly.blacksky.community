import _ from "underscore";
import { encode } from "html-entities";
import replaceStream from "replacestream";
import request from "request-promise"; // includes Request, but adds promise methods

import { ConversationType } from "../d";
import { failJson } from "./fail";
import Config from "../config";
import logger from "./logger";

function makeFileFetcher(
  hostname?: string,
  port?: string | number,
  path?: string,
  headers?: { "Content-Type": string },
  preloadData?: { conversation?: ConversationType }
) {
  return function (
    req: { headers?: { host: any }; path: any; pipe: (arg0: any) => void },
    res: { set: (arg0: any) => void }
  ) {
    if (!hostname) {
      failJson(res, 500, "polis_err_file_fetcher_serving_to_domain");
      return;
    }
    const url = "http://" + hostname + ":" + port + path;
    logger.info("fetch file from " + url);
    let x = request(url);
    req.pipe(x);
    if (!_.isUndefined(preloadData)) {
      x = x.pipe(
        replaceStream(
          '"REPLACE_THIS_WITH_PRELOAD_DATA"',
          JSON.stringify(preloadData)
        )
      );
    }

    const defaultTitle = "Blacksky People's Assembly";
    const defaultDescription =
      "Blacksky People\u2019s Assembly \u2013 a space for public deliberation and collective decision-making.";
    const defaultImage =
      "https://blacksky-cdn.nyc3.cdn.digitaloceanspaces.com/peoples-assembly.png";

    const title =
      preloadData?.conversation?.topic || defaultTitle;
    const description =
      preloadData?.conversation?.description || defaultDescription;
    const image = defaultImage;

    let fbMetaTagsString = '<meta property="og:type" content="website">\n';
    fbMetaTagsString +=
      '    <meta property="og:title" content="' + encode(title) + '" />\n';
    fbMetaTagsString +=
      '    <meta name="description" content="' + encode(description) + '">\n';
    fbMetaTagsString +=
      '    <meta property="og:description" content="' +
      encode(description) +
      '" />\n';
    fbMetaTagsString +=
      '    <meta property="og:image" content="' + image + '" />\n';
    if (
      preloadData?.conversation?.conversation_id &&
      req?.headers?.host
    ) {
      fbMetaTagsString +=
        '    <meta property="og:url" content="https://' +
        encode(req.headers.host) +
        "/" +
        encode(preloadData.conversation.conversation_id) +
        '" />\n';
    }
    fbMetaTagsString +=
      '    <meta name="twitter:card" content="summary_large_image">\n';
    fbMetaTagsString +=
      '    <meta property="twitter:title" content="' +
      encode(title) +
      '" />\n';
    fbMetaTagsString +=
      '    <meta property="twitter:description" content="' +
      encode(description) +
      '" />\n';
    fbMetaTagsString +=
      '    <meta property="twitter:image" content="' + image + '" />\n';

    x = x.pipe(
      replaceStream('<meta name="REPLACE_THIS_WITH_FB_META_TAGS" content="placeholder">', fbMetaTagsString)
    );

    res.set(headers);

    // @ts-ignore - Legacy Express v3 response type mismatch
    x.pipe(res);
    x.on("error", function (err: any) {
      failJson(res, 500, "polis_err_finding_file " + path, err);
    });
  };
}

function browserSupportsPushState(req: { headers?: { [x: string]: string } }) {
  return !/MSIE [23456789]/.test(req?.headers?.["user-agent"] || "");
}

function fetchIndex(
  req: {
    path: string;
    headers?: { host: string; "user-agent"?: string; origin?: string };
    pipe: (arg0: any) => void;
  },
  res: {
    writeHead: (arg0: number, arg1: { Location: string }) => void;
    end: () => any;
    set: (arg0: any) => void;
    status?: (code: number) => any;
    header?: (name: string, value: any) => void;
    _headers?: { [key: string]: any };
    redirect?: (url: string) => void;
  },
  preloadData: { conversation?: ConversationType },
  port: string | number | undefined
) {
  const headers = {
    "Content-Type": "text/html",
  };
  if (!Config.isDevMode) {
    Object.assign(headers, {
      "Cache-Control": "no-cache",
    });
  }

  const indexPath = "/index.html";

  function isUnsupportedBrowser(req: { headers?: { [x: string]: string } }) {
    return /MSIE [234567]/.test(req?.headers?.["user-agent"] || "");
  }

  const doFetch = makeFileFetcher(
    Config.staticFilesHost,
    port,
    indexPath,
    headers,
    preloadData
  );
  if (isUnsupportedBrowser(req)) {
    // @ts-ignore - Legacy Express v3 request type mismatch
    const fetchUnsupportedBrowserPage = makeFileFetcher(
      Config.staticFilesHost,
      Config.staticFilesParticipationPort,
      "/unsupportedBrowser.html",
      {
        "Content-Type": "text/html",
      }
    );
    return fetchUnsupportedBrowserPage(req, res);
  } else if (
    !browserSupportsPushState(req) &&
    req.path.length > 1 &&
    !/^\/api/.exec(req.path)
  ) {
    res.writeHead(302, {
      Location: "https://" + req?.headers?.host + "/#" + req.path,
    });

    return res.end();
  } else {
    // @ts-ignore - Legacy Express v3 request type mismatch
    return doFetch(req, res);
  }
}

export { makeFileFetcher, fetchIndex };
