import { getLibraries } from "@/app/actions"
import { KnowledgeBase } from "@/components/kb/knowledge-base"

export const dynamic = "force-dynamic"

export default async function Page() {
  const libraries = await getLibraries()
  return <KnowledgeBase initialLibraries={libraries} />
}
