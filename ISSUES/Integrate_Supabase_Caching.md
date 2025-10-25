### Title: Integrate Supabase for Real-Time Caching of Profile Page and Marketplace Listings

#### Description:
Currently, users fetch profile and marketplace listing data every time they visit, causing unnecessary API calls and slower load times. We want to integrate Supabase as a caching layer to improve performance and ensure a real-time, up-to-date experience.  

#### Requirements:
- Integrate Supabase client  
- Cache user profile data and marketplace listings (including NFTs)  
- Ensure cached data is updated in real-time (using Supabase real-time subscriptions or similar)  
- Always fetch new listings and NFTs as soon as they are available, falling back to Supabase cache for fast loads  
- Keep fetching logic compatible with Supabase so that users always have the latest data  
- Invalidate/update cache immediately when data changes  

#### Benefits:
- Fewer repeated API calls  
- Faster page loads  
- Real-time updates for users  
- Improved reliability and UX

Please add tasks and feedback as needed.