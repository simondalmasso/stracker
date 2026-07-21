'use client'

import dynamic from 'next/dynamic'

const MobileLocationApp = dynamic(
  () => import('@/components/mobile/MobileLocationApp'),
  {
    ssr: false,
    loading: () => (
      <main className="grid min-h-[100dvh] w-full place-items-center overflow-hidden bg-black text-white">
        <p className="text-sm font-medium text-white/55">Cargando STRACKER…</p>
      </main>
    ),
  },
)

export default function Home() {
  return <MobileLocationApp />
}
