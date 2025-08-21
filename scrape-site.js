#!/usr/bin/env node

import fs from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";
import * as cheerio from "cheerio";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

// Get the directory name of the current module
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- HELPER FUNCTIONS ---

/**
 * Cleans a string by replacing multiple whitespace characters with a single space
 * and trimming leading/trailing whitespace.
 * @param {string} text - The text to clean.
 * @returns {string} The cleaned text.
 */
function cleanText(text) {
  if (!text) return "";
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Counts the occurrences of each item in an array.
 * @param {Array<string>} arr - The array of strings to count.
 * @returns {Object} An object mapping items to their counts.
 */
function countOccurrences(arr) {
  return arr.reduce((acc, curr) => {
    acc[curr] = (acc[curr] || 0) + 1;
    return acc;
  }, {});
}

/**
 * Finds the most frequent item in an array.
 * @param {Array<string>} arr - The array to search in.
 * @returns {string | null} The most frequent item, or null if the array is empty.
 */
function findMostFrequent(arr) {
  if (!arr || !arr.length) return null;
  const counts = countOccurrences(arr);
  return Object.keys(counts).reduce((a, b) => (counts[a] > counts[b] ? a : b));
}

/**
 * A simple CSS parser to convert CSS text into a structured array.
 * This is a best-effort parser and may not handle all complex CSS cases.
 * @param {string} cssText - The full CSS content.
 * @returns {Array<{selector: string, declarations: object}>} An array of rule objects.
 */
function parseCss(cssText) {
  const rules = [];
  // Remove comments
  cssText = cssText.replace(/\/\*[\s\S]*?\*\//g, "");
  // Match CSS rules more robustly
  const ruleRegex = /([^{]+)\s*\{([^}]+)\}/g;
  let match;
  while ((match = ruleRegex.exec(cssText)) !== null) {
    const selectors = match[1]
      .trim()
      .split(",")
      .map((s) => s.trim());
    const declarationsText = match[2].trim();
    const declarations = {};
    declarationsText.split(";").forEach((decl) => {
      const parts = decl.split(":");
      if (parts.length === 2) {
        const property = parts[0].trim();
        const value = parts[1].trim();
        declarations[property] = value;
      }
    });
    selectors.forEach((selector) => {
      rules.push({ selector, declarations });
    });
  }
  return rules;
}

// --- CORE LOGIC ---

/**
 * Scrapes the website and generates initial data files for manual editing.
 * @param {object} argv - The command-line arguments from yargs.
 */
async function runScraper(argv) {
  const { url, client, force } = argv;
  console.log(`\nScraping site for client: ${client}`);

  const outputDir = path.join(__dirname, "lib", client);
  const cacheDir = path.join(__dirname, "scraper_cache", client);
  const cacheFile = path.join(cacheDir, "index.html");
  let html;
  const siteUrl = new URL(url);

  try {
    // --- CACHE HANDLING ---
    if (!force && fs.existsSync(cacheFile)) {
      console.log(`Loading content from local cache...`);
      html = await fs.readFile(cacheFile, "utf8");
    } else {
      console.log(`Fetching content from ${url}...`);
      const response = await axios.get(url, {
        headers: { "User-Agent": "KamajiScraper/1.0" },
      });
      html = response.data;
      await fs.ensureDir(cacheDir);
      await fs.writeFile(cacheFile, html);
      console.log(`Content saved to cache.`);
    }

    const $ = cheerio.load(html);

    // --- CSS EXTRACTION AND PARSING ---
    console.log("Fetching and parsing stylesheets...");
    let allCss = "";
    $("style").each((i, el) => {
      allCss += $(el).html();
    });
    const stylesheetPromises = [];
    $('link[rel="stylesheet"]').each((i, el) => {
      const href = $(el).attr("href");
      if (href) {
        const stylesheetUrl = new URL(href, siteUrl.origin).href;
        stylesheetPromises.push(
          axios
            .get(stylesheetUrl)
            .then((res) => res.data)
            .catch(() => "")
        );
      }
    });
    allCss += (await Promise.all(stylesheetPromises)).join("\n");

    const cssRules = parseCss(allCss);

    // --- DATA AND STYLE MAPPING ---
    console.log("Mapping content to styles...");
    const styleMap = [];
    // Updated selector to include structural tags like body, header, and footer
    const elementsToProcess = $(
      "body, header, footer, h1, h2, h3, h4, p, span"
    );

    elementsToProcess.each((i, el) => {
      const element = $(el);
      const tagName = element.prop("tagName").toLowerCase();
      // Get only the immediate text of an element, not its children's text.
      const content = cleanText(
        element.clone().children().remove().end().text()
      );
      const classes = element.attr("class");

      // Skip elements with no meaningful text, unless it's a key structural tag
      if (
        content.length < 5 &&
        !["body", "header", "footer"].includes(tagName)
      ) {
        return;
      }

      const appliedStyles = {};
      const classStyles = {};

      // Get computed styles for the element
      cssRules.forEach((rule) => {
        try {
          if (element.is(rule.selector)) {
            Object.assign(appliedStyles, rule.declarations);
          }
        } catch (e) {
          // Ignore complex selectors that Cheerio can't handle
        }
      });

      // Get styles for each individual class
      if (classes) {
        const classList = classes.split(" ").filter(Boolean);
        classList.forEach((className) => {
          cssRules.forEach((rule) => {
            // Check if the rule's selector targets this class
            if (rule.selector.includes(`.${className}`)) {
              classStyles[className] = classStyles[className] || {};
              Object.assign(classStyles[className], rule.declarations);
            }
          });
        });
      }

      const inlineStyles = element.attr("style");
      if (inlineStyles) {
        inlineStyles.split(";").forEach((decl) => {
          const parts = decl.split(":");
          if (parts.length === 2) {
            appliedStyles[parts[0].trim()] = parts[1].trim();
          }
        });
      }

      // Include element if it has styles OR classes
      if (Object.keys(appliedStyles).length > 0 || classes) {
        const mapObject = {
          tagName: tagName,
          // For structural tags, we only care about styles, not aggregated content.
          content: ["body", "header", "footer"].includes(tagName)
            ? ""
            : content,
          styles: appliedStyles,
        };

        if (classes) {
          mapObject.classes = classes.split(" ").filter((c) => c); // Add classes as an array
        }
        if (Object.keys(classStyles).length > 0) {
          mapObject.classStyles = classStyles; // Add the styles for each class
        }

        styleMap.push(mapObject);
      }
    });

    // --- SMARTER THEME DERIVATION ---
    console.log("Deriving theme with improved logic...");
    let bodyBackgroundColor = null;
    // Prioritize finding the direct body or html background color
    for (let i = cssRules.length - 1; i >= 0; i--) {
      const rule = cssRules[i];
      if (
        rule.selector === "body" ||
        rule.selector === "html" ||
        rule.selector.includes("body.custom-background")
      ) {
        if (rule.declarations["background-color"]) {
          bodyBackgroundColor = rule.declarations["background-color"];
          break;
        }
        if (rule.declarations["background"]) {
          // Simple regex to find color in a complex 'background' property
          const colorMatch = rule.declarations["background"].match(
            /#(?:[0-9a-f]{3}){1,2}|rgba?\([^)]+\)|rgb\([^)]+\)/
          );
          if (colorMatch) {
            bodyBackgroundColor = colorMatch[0];
            break;
          }
        }
      }
    }

    const allTypographyStyles = styleMap.map((item) => item.styles);
    const headingStyles = styleMap
      .filter((item) => item.tagName.startsWith("h"))
      .map((item) => item.styles);
    const bodyStyles = styleMap
      .filter((item) => item.tagName === "p")
      .map((item) => item.styles);

    const themeColors = {
      primary: findMostFrequent(headingStyles.map((s) => s.color)) || "#000000",
      text: findMostFrequent(bodyStyles.map((s) => s.color)) || "#000000",
      background:
        bodyBackgroundColor ||
        findMostFrequent(
          allTypographyStyles.map((s) => s["background-color"])
        ) ||
        "#ffffff",
      secondary: "#000000",
    };

    const typography = {
      headingFont:
        findMostFrequent(
          headingStyles.map((s) => s["font-family"]?.split(",")[0].trim())
        ) || "",
      bodyFont:
        findMostFrequent(
          bodyStyles.map((s) => s["font-family"]?.split(",")[0].trim())
        ) || "",
      headingWeight:
        findMostFrequent(headingStyles.map((s) => s["font-weight"])) || "",
      bodyWeight:
        findMostFrequent(bodyStyles.map((s) => s["font-weight"])) || "",
      headingLineHeight:
        findMostFrequent(headingStyles.map((s) => s["line-height"])) || "",
      bodyLineHeight:
        findMostFrequent(bodyStyles.map((s) => s["line-height"])) || "",
    };

    // --- FILE GENERATION ---
    console.log("Generating output files...");
    await fs.ensureDir(outputDir);

    // 1. <client>.json (initial template)
    const initialConfig = {
      theme: "",
      colors: themeColors,
      typography: typography,
      pages: [
        {
          component: "Header",
          props: { logo: { type: "text", content: "" }, navLinks: [] },
        },
        { component: "HeroSection", props: { title: "", subtitle: "" } },
        { component: "ServicesGrid", props: { title: "", services: [] } },
        { component: "Footer", props: { copyrightText: "", socialLinks: [] } },
      ],
    };
    await fs.writeJson(path.join(outputDir, `${client}.json`), initialConfig, {
      spaces: 2,
    });

    // 2. style_map.json (new structured data file)
    await fs.writeJson(path.join(outputDir, "style_map.json"), styleMap, {
      spaces: 2,
    });

    console.log(`\n✅ Success! Initial files created in: ${outputDir}`);
    console.log(
      `\nNext Step: Use '${client}.json' and 'style_map.json' as context for the AI.`
    );
  } catch (error) {
    console.error(`\nError during scraping:`, error.stack);
  }
}

// --- Yargs CLI Setup ---
yargs(hideBin(process.argv))
  .command(
    "$0 <url> <client>",
    "Scrape a website and generate structured data files for AI processing.",
    (yargs) => {
      return yargs
        .positional("url", {
          describe: "The full URL of the website to scrape",
          type: "string",
        })
        .positional("client", {
          describe: "The client ID for the output folder",
          type: "string",
        })
        .option("force", {
          alias: "f",
          type: "boolean",
          description: "Force re-downloading content",
          default: false,
        });
    },
    runScraper
  )
  .demandCommand(1)
  .help()
  .parse();
