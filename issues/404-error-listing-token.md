**Title:** 404 Error when Listing Token for Sale

**Description:**
Pressing 'list for sale' on a token from the profile page returns a 404 (Not Found) on the production site (https://wileywest-marketplace.vercel.app/sell?contract=0x2D732b0Bb33566A13E586aE83fB21d2feE34e906&tokenId=26), but works correctly on the local development server. 

**Steps to Reproduce:**
1. Go to the profile page.
2. Select a token.
3. Click on 'list for sale'.

**Expected Result:**
The token should be listed for sale without errors.

**Actual Result:**
A 404 error is returned.

**Request:**
Please investigate why the route is not found in production and resolve the discrepancy.