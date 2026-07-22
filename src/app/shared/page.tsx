import type { Metadata } from 'next'
import NativeViewerApp from '@/components/mobile/NativeViewerApp'

export const metadata: Metadata = {
  title: 'Ubicación compartida · STRACKER',
  referrer: 'no-referrer',
  robots: {
    index: false,
    follow: false,
    noarchive: true,
    nosnippet: true,
    noimageindex: true,
  },
}

export default function SharedViewerPage() {
  return <NativeViewerApp />
}
