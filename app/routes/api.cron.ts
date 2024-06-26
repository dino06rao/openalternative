import type { LoaderFunctionArgs } from "@remix-run/node"
import { kv } from "@vercel/kv"
import { got } from "got"
import { prisma } from "~/services.server/prisma"
import { SITE_URL } from "~/utils/constants"
import { getRepoOwnerAndName } from "~/utils/github"
import { getStarCount, getSubscriberCount, getToolCount } from "~/utils/stats"

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.headers.get("Authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 })
  }

  const tools = await prisma.tool.findMany({
    where: { publishedAt: { not: null } },
    select: { id: true, repository: true, website: true, bump: true },
  })

  // Store the stats in KV
  await kv.set("stats", {
    tools: await getToolCount(),
    stars: await getStarCount(),
    subscribers: await getSubscriberCount(),
  })

  // Trigger a new event for each repository
  await Promise.all(
    tools.map(async ({ id, bump, repository }) => {
      const repo = getRepoOwnerAndName(repository)

      if (repo) {
        return got
          .post(`${SITE_URL}/api/fetch-repository`, {
            json: { id, bump, owner: repo.owner, name: repo.name },
            headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
          })
          .json()
      }
    }),
  )

  // Once it's finished, clear out empty languages and topics
  await Promise.all([
    prisma.language.deleteMany({ where: { tools: { none: {} } } }),
    prisma.topic.deleteMany({ where: { tools: { none: {} } } }),
  ])

  // Run Algolia indexing
  await got.post(`https://data.us.algolia.com/1/tasks/${process.env.ALGOLIA_INDEX_TASK_ID}/run`, {
    headers: {
      "X-Algolia-API-Key": process.env.ALGOLIA_ADMIN_API_KEY,
      "X-Algolia-Application-Id": process.env.VITE_ALGOLIA_APP_ID,
    },
  })

  return new Response("OK", { status: 200 })
}
