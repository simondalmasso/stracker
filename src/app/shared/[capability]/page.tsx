import NativeViewerApp from '@/components/mobile/NativeViewerApp'

export function generateStaticParams() {
  return [{ capability: '__capability__' }]
}

export default function SharedViewerPage() {
  return <NativeViewerApp />
}
