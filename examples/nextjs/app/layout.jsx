export const metadata = { title: 'OCR with Next.js' };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ font: '15px/1.5 system-ui, sans-serif', margin: 24, maxWidth: 760 }}>{children}</body>
    </html>
  );
}
