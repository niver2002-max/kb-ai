import { getKbState } from "@/app/actions"
import { KnowledgeBase } from "@/components/kb/knowledge-base"

export const dynamic = "force-dynamic"

export default async function Page() {
  const initial = await getKbState()
  return <KnowledgeBase initial={initial} />
}
