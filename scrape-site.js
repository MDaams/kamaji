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

/**
 * Cleans a string by replacing multiple whitespace characters with a single space
 * and trimming leading/trailing whitespace.
 * @param {string} text - The text to clean.
 * @returns {string} The cleaned text.
 */
function cleanText(text) {
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
 * Finds the most frequent item in an array.G
 * @param {Array<string>} arr - The array to search in.
 * @returns {string | null} The most frequent item, or null if the array is empty.
 */
function findMostFrequent(arr) {
  if (!arr.length) return null;
  const counts = countOccurrences(arr);
  return Object.keys(counts).reduce((a, b) => (counts[a] > counts[b] ? a : b));
}

/**
 * Main function to run the scraper.
 * @param {object} argv - The command-line arguments from yargs.
 */
async function runScraper(argv) {
  const { url, client, force } = argv;
  console.log(`Analyzing site for client: ${client}`);

  // Define output and cache directories
  const outputDir = path.join(__dirname, "lib", client);
  const cacheDir = path.join(__dirname, "scraper_cache", client);
  const cacheFile = path.join(cacheDir, "index.html");
  let html;

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

    // --- STEP 1: SCRAPE HEADERS AND PARAGRAPHS ---
    console.log("Scraping headers and paragraphs...");
    const scrapedData = [];
    $("body")
      .find("h1, h2, h3, h4, h5, h6")
      .each((i, el) => {
        const headingElement = $(el);
        const heading = cleanText(headingElement.text());
        const paragraphs = headingElement
          .nextUntil("h1, h2, h3, h4, h5, h6")
          .filter("p")
          .map((i, p) => cleanText($(p).text()))
          .get()
          .filter((p) => p.length > 20);
        if (heading.length > 3 && paragraphs.length > 0) {
          scrapedData.push({ heading, paragraphs });
        }
      });

    // --- STEP 2: INTELLIGENTLY SCAN FOR COLORS ---
    console.log("Intelligently scanning for theme colors...");
    const backgroundColors = [];
    const textColors = [];
    const otherColors = [];
    const colorRegex =
      /#(?:[0-9a-f]{3}){1,2}|rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*[\d.]+\s*)?\)/gi;

    $("style").each((i, el) => {
      const stylesheet = $(el).html();
      // Split stylesheet into lines for property analysis
      stylesheet.split("\n").forEach((line) => {
        const matches = line.match(colorRegex);
        if (matches) {
          matches.forEach((color) => {
            const c = color.toLowerCase();
            if (
              c === "#fff" ||
              c === "#ffffff" ||
              c === "#000" ||
              c === "#000000"
            ) {
              return; // Skip pure black and white for primary/accent roles
            }
            if (
              line.includes("background-color") ||
              line.includes("background:")
            ) {
              backgroundColors.push(c);
            } else if (line.includes("color:")) {
              textColors.push(c);
            } else {
              otherColors.push(c);
            }
          });
        }
      });
    });

    // Determine theme colors based on frequency and context
    const mostFrequentBg = findMostFrequent(backgroundColors);
    const mostFrequentText = findMostFrequent(textColors);

    // Filter out bg/text colors from 'other' to find accent/primary
    const accentCandidates = otherColors.filter(
      (c) => c !== mostFrequentBg && c !== mostFrequentText
    );
    const sortedAccents = Object.entries(countOccurrences(accentCandidates))
      .sort(([, a], [, b]) => b - a)
      .map(([color]) => color);

    const themeColors = {
      primary: sortedAccents[0] || "#000000",
      secondary: sortedAccents[1] || "#000000",
      background: mostFrequentBg || "#000000",
      "background-alt":
        backgroundColors.find((c) => c !== mostFrequentBg) || "#000000",
      text: mostFrequentText || "#000000",
      "text-muted": textColors.find((c) => c !== mostFrequentText) || "#000000",
      accent: sortedAccents[2] || "#000000",
    };

    // --- STEP 3: CREATE THE JSON STRUCTURE FOR CONFIG ---
    console.log("Building data structure for config.json...");
    const configData = {
      theme: "",
      colors: themeColors,
      typography: {
        headingFont: "",
        bodyFont: "",
        headingWeight: "",
        bodyWeight: "",
        headingLineHeight: "",
        bodyLineHeight: "",
      },
      pages: [
        {
          component: "Header",
          props: {
            logo: { type: "text", content: "" },
            navLinks: [],
            cta: { text: "", href: "" },
            secondaryLinks: { info: "", links: [] },
          },
        },
        {
          component: "HeroSection",
          props: {
            title: "",
            subtitle: "",
            ctaText1: "",
            ctaLink1: "",
            ctaText2: "",
            ctaLink2: "",
            backgroundImage: "",
            videoUrl: "",
          },
        },
        {
          component: "ServicesGrid",
          props: { title: "", subtitle: "", services: [] },
        },
        {
          component: "TestimonialSection",
          props: { title: "", subtitle: "", testimonials: [] },
        },
        {
          component: "CallToActionSection",
          props: {
            headline: "",
            subheading: "",
            primaryButtonText: "",
            primaryButtonLink: "",
            secondaryButtonText: "",
            secondaryButtonLink: "",
            imageUrl: "",
          },
        },
        {
          component: "Footer",
          props: {
            copyrightText: "",
            logoUrl: "",
            socialLinks: [],
            sitemapLinks: [],
            contactInfo: { address: "", phone: "", email: "" },
          },
        },
      ],
    };

    // --- STEP 4: CREATE THE CLIENT DIRECTORY AND OUTPUT FILES ---
    await fs.ensureDir(outputDir);

    const configOutputPath = path.join(outputDir, "config.json");
    await fs.writeJson(configOutputPath, configData, { spaces: 2 });
    console.log(`- Config.json scaffold with detected colors saved.`);

    const scrapedOutputPath = path.join(outputDir, "scraped-content.json");
    await fs.writeJson(scrapedOutputPath, scrapedData, { spaces: 2 });
    console.log(`- Scraped content saved to: ${scrapedOutputPath}`);

    console.log("Generating a simple HTML view for easy copying...");
    let htmlBody = "";
    for (const section of scrapedData) {
      htmlBody += `    <h2>${section.heading}</h2>\n`;
      for (const paragraph of section.paragraphs) {
        htmlBody += `    <p>${paragraph}</p>\n`;
      }
      htmlBody += "    <hr>\n";
    }

    const finalHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Scraped Content for ${client}</title>
  <style>
    body { font-family: sans-serif; line-height: 1.6; max-width: 800px; margin: 2rem auto; padding: 0 1rem; }
    h1, h2 { color: #333; }
    hr { border: 0; border-top: 1px solid #eee; margin: 2rem 0; }
    p { color: #555; }
  </style>
</head>
<body>
  <h1>Scraped Content for: ${client}</h1>
  <hr>
  ${htmlBody}
</body>
</html>`;
    const htmlOutputPath = path.join(outputDir, "scraped-view.html");
    await fs.writeFile(htmlOutputPath, finalHtml.trim());
    console.log(`- Simple HTML view saved to: ${htmlOutputPath}`);

    console.log(
      `\nSuccess! Project files for "${client}" created in: ${outputDir}`
    );
    console.log(
      `\nNext step: Open 'scraped-view.html' and use it to populate 'config.json'.`
    );
  } catch (error) {
    console.error(`\nError: An error occurred during the scraping process.`);
    console.error(error.stack);
  }
}

// --- Yargs CLI Setup ---
yargs(hideBin(process.argv))
  .command(
    "$0 <url> <client>",
    "Scrapes a website and creates a configuration folder for the client.",
    (yargs) => {
      return yargs
        .positional("url", {
          describe: "The full URL of the website to scrape",
          type: "string",
        })
        .positional("client", {
          describe: "The client ID to use for the output folder (e.g., destec)",
          type: "string",
        })
        .option("force", {
          alias: "f",
          type: "boolean",
          description: "Force re-downloading the content, ignoring the cache",
          default: false,
        });
    },
    (argv) => {
      runScraper(argv);
    }
  )
  .demandCommand(2, "You must provide a URL and a client ID.")
  .help().argv;
