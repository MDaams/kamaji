# First time scraping a client:

node scrape-site.js http://<site>.com <sitename>
(This will download the HTML and save it to scraper_cache/destec/index.html)

# Running it again to test your parsing logic:

node scrape-site.js http://<site>.com <sitename>
(This will instantly load the content from the cache file)

# If the client's website has changed and you need the latest version:

node scrape-site.js http://<site>.com <sitename> --force
(This will ignore the cache, re-download the HTML, and overwrite the old cache file)
