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
 * Extracts a CSS property value for a given selector from stylesheet text.
 * @param {string} css - The stylesheet content.
 * @param {string} selector - The CSS selector (e.g., 'body', 'h1').
 * @param {string} property - The CSS property (e.g., 'font-family').
 * @returns {string | null} The found value or null.
 */
function findCssValue(css, selector, property) {
  const regex = new RegExp(
    `${selector}\\s*{[^}]*${property}:\\s*([^;}]+)`,
    "i"
  );
  const match = css.match(regex);
  if (match && match[1]) {
    return match[1].split(",")[0].replace(/['"]/g, "").trim();
  }
  return null;
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

    // --- DATA EXTRACTION ---
    console.log("Extracting content, styles, and structure...");

    // Scrape Text Content
    const scrapedData = [];
    $("body")
      .find("h1, h2, h3, h4, h5, h6")
      .each((i, el) => {
        const heading = cleanText($(el).text());
        const paragraphs = $(el)
          .nextUntil("h1, h2, h3, h4, h5, h6")
          .filter("p")
          .map((i, p) => cleanText($(p).text()))
          .get()
          .filter((p) => p.length > 20);
        if (heading.length > 3 && paragraphs.length > 0) {
          scrapedData.push({ heading, paragraphs });
        }
      });

    // Fetch and Analyze CSS
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

    // Analyze Colors
    const backgroundColors = [];
    const textColors = [];
    const allColors = [];
    const colorRegex =
      /#(?:[0-9a-f]{3}){1,2}|rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*[\d.]+\s*)?\)/gi;

    const cssDeclarations = allCss.match(/[^\{\}]+\{[^\{\}]+\}/g) || [];
    cssDeclarations.forEach((declaration) => {
      const parts = declaration.split("{");
      const properties = parts[1];
      const colors = properties.match(colorRegex);
      if (colors) {
        colors.forEach((color) => {
          const c = color.toLowerCase();
          if (
            c !== "#fff" &&
            c !== "#ffffff" &&
            c !== "#000" &&
            c !== "#000000"
          ) {
            allColors.push(c);
            if (properties.includes("background")) {
              backgroundColors.push(c);
            } else if (properties.includes("color")) {
              textColors.push(c);
            }
          }
        });
      }
    });

    const mostFrequentBg = findMostFrequent(backgroundColors);
    const mostFrequentText = findMostFrequent(textColors);

    // Find primary/accent colors from the remaining pool
    const otherColors = allColors.filter(
      (c) => c !== mostFrequentBg && c !== mostFrequentText
    );

    const themeColors = {
      primary: findMostFrequent(otherColors) || "#000000",
      secondary:
        otherColors.filter((c) => c !== findMostFrequent(otherColors))[0] ||
        "#000000",
      background: mostFrequentBg || "#000000",
      text: mostFrequentText || "#000000",
    };

    // Analyze Typography
    const typography = {
      headingFont: findCssValue(allCss, "h1", "font-family") || "",
      bodyFont: findCssValue(allCss, "body, p", "font-family") || "",
      headingWeight: findCssValue(allCss, "h1", "font-weight") || "",
      bodyWeight: findCssValue(allCss, "body, p", "font-weight") || "",
      headingLineHeight: findCssValue(allCss, "h1", "line-height") || "",
      bodyLineHeight: findCssValue(allCss, "body, p", "line-height") || "",
    };

    // Scrape Header & Footer
    const headerEl = $('header, [role="banner"]').first();
    const footerEl = $('footer, [role="contentinfo"]').first();
    const logoEl = headerEl.find('img[class*="logo"]').first();
    const headerProps = {
      logo: {
        type: logoEl.length ? "image" : "text",
        content: logoEl.length
          ? new URL(logoEl.attr("src"), siteUrl.origin).href
          : cleanText(headerEl.find('a[class*="logo"]').text()),
      },
      navLinks: headerEl
        .find("nav a")
        .map((i, el) => ({
          text: cleanText($(el).text()),
          href: new URL($(el).attr("href"), siteUrl.origin).href,
        }))
        .get(),
    };
    const footerProps = {
      copyrightText: cleanText(footerEl.find('[class*="copyright"]').text()),
      socialLinks: footerEl
        .find('a[href*="facebook.com"], a[href*="twitter.com"]')
        .map((i, el) => ({
          platform: $(el)
            .attr("href")
            .match(/(facebook|twitter)/)[0],
          url: $(el).attr("href"),
        }))
        .get(),
    };

    // --- FILE GENERATION ---
    console.log("Generating initial output files...");
    await fs.ensureDir(outputDir);

    // 1. <client>.json (initial template)
    const initialConfig = {
      theme: "",
      colors: themeColors,
      typography,
      pages: [
        { component: "Header", props: headerProps },
        { component: "HeroSection", props: { title: "", subtitle: "" } },
        { component: "ServicesGrid", props: { title: "", services: [] } },
        { component: "Footer", props: footerProps },
      ],
    };
    await fs.writeJson(path.join(outputDir, `${client}.json`), initialConfig, {
      spaces: 2,
    });

    // 2. scraped-content.json
    await fs.writeJson(
      path.join(outputDir, "scraped-content.json"),
      scrapedData,
      { spaces: 2 }
    );

    // 3. scraped-view.html
    const generatedStyles = `
      body {
        background-color: ${themeColors.background};
        color: ${themeColors.text};
        font-family: ${typography.bodyFont || "sans-serif"};
        font-weight: ${typography.bodyWeight || "normal"};
        line-height: ${typography.bodyLineHeight || "1.6"};
        max-width: 800px;
        margin: 2rem auto;
        padding: 1rem;
      }
      h1, h2, h3, h4, h5, h6 {
        color: ${themeColors.primary};
        font-family: ${typography.headingFont || "sans-serif"};
        font-weight: ${typography.headingWeight || "bold"};
        line-height: ${typography.headingLineHeight || "1.2"};
      }
      a {
        color: ${themeColors.primary};
      }
      hr {
        border: 0;
        border-top: 1px solid #eee;
        margin: 2rem 0;
      }
    `;

    const htmlView = `
      <!DOCTYPE html><html lang="en">
      <head>
        <meta charset="UTF-8">
        <title>Scraped Content for ${client}</title>
        <style>${generatedStyles}</style>
      </head>
      <body>
        <h1>Scraped Content: ${client}</h1><hr>
        ${scrapedData
          .map(
            (s) =>
              `<h2>${s.heading}</h2>${s.paragraphs
                .map((p) => `<p>${p}</p>`)
                .join("")}`
          )
          .join("<hr>")}
      </body>
      </html>`;
    await fs.writeFile(
      path.join(outputDir, "scraped-view.html"),
      htmlView.trim()
    );

    console.log(`\n✅ Success! Initial files created in: ${outputDir}`);
    console.log(
      `\nNext Step: Manually edit '${client}.json' using the content from 'scraped-view.html'.`
    );
  } catch (error) {
    console.error(`\nError during scraping:`, error.stack);
  }
}

// --- Yargs CLI Setup ---
yargs(hideBin(process.argv))
  .command(
    "$0 <url> <client>",
    "Scrape a website and generate initial data files for manual configuration.",
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
