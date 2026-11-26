import { CampanhaClient } from "./_client";

export const dynamic = "force-dynamic";

export default async function CampanhaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CampanhaClient id={id} />;
}
