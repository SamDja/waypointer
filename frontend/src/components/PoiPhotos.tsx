import { useEffect, useMemo, useState, type ReactNode } from "react"
import { Camera, ExternalLink, ImageOff } from "lucide-react"

import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
  type CarouselApi,
} from "@/components/ui/carousel"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { fetchPoiPhotos } from "@/lib/api"
import { formatExactDateTime, formatRelativeDate } from "@/lib/osmTagLabels"
import { PHOTO_SOURCE_LABELS, photoTags } from "@/lib/poiPhotos"
import type { PoiPhoto, PoiPhotosResponse } from "@/types/candidate"

// Tagged with the request it answers, so a popup whose tags change shows
// "loading" again without resetting state inside the effect.
type PhotosState =
  | { key: string; status: "done"; result: PoiPhotosResponse }
  | { key: string; status: "error" }

// The photos an OSM element's tags point to, for its map popup - or, when it
// has none, a nudge to take one. Fetched when mounted, which is when the
// popup opens, so a search's hundred candidates don't each cost a request.
// A failure is one quiet line rather than a toast: photos are a bonus on
// top of the popup, the same rule as MapPoiOverlay.
export function PoiPhotos({
  name,
  tags,
  osmEditUrl,
}: {
  name: string | null
  tags: Record<string, string>
  osmEditUrl: string
}) {
  const requestTags = useMemo(() => photoTags(tags), [tags])
  // Tags arrive as a fresh object on every parent render; the JSON string is
  // what actually says whether there's something new to fetch.
  const requestKey = JSON.stringify(requestTags)
  const hasRefs = Object.keys(requestTags).length > 0
  const [state, setState] = useState<PhotosState | null>(null)

  useEffect(() => {
    if (!hasRefs) return
    const controller = new AbortController()
    fetchPoiPhotos(JSON.parse(requestKey), controller.signal)
      .then((result) => setState({ key: requestKey, status: "done", result }))
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return
        setState({ key: requestKey, status: "error" })
      })
    return () => controller.abort()
  }, [requestKey, hasRefs])

  if (!hasRefs) return <PhotoNudge name={name} osmEditUrl={osmEditUrl} />
  if (!state || state.key !== requestKey) {
    return <div className="mt-2 mx-auto aspect-4/3 w-[min(100%,calc(var(--poi-photo-height)*4/3))] animate-pulse rounded-item bg-muted" aria-label="Loading photos" />
  }
  if (state.status === "error") {
    return <p className="mt-1 text-xs text-muted-foreground">Couldn't load photos.</p>
  }
  const { photos, links } = state.result
  if (photos.length === 0 && links.length === 0) return <PhotoNudge name={name} osmEditUrl={osmEditUrl} />
  return (
    <div className="mt-2 w-80 max-w-full">
      {photos.length > 0 && <PhotoCarousel photos={photos} />}
      {links.map((link) => (
        <a
          key={link.url}
          href={link.url}
          target="_blank"
          rel="noreferrer"
          className="mt-1 flex items-center gap-1 text-xs text-primary underline"
        >
          View photo on {PHOTO_SOURCE_LABELS[link.source] ?? link.source}
          <ExternalLink className="size-3" />
        </a>
      ))}
    </div>
  )
}

function PhotoCarousel({ photos }: { photos: PoiPhoto[] }) {
  const [api, setApi] = useState<CarouselApi>()
  const [current, setCurrent] = useState(0)

  useEffect(() => {
    if (!api) return
    const onSelect = () => setCurrent(api.selectedScrollSnap())
    onSelect()
    api.on("select", onSelect)
    return () => {
      api.off("select", onSelect)
    }
  }, [api])

  const photo = photos[current] ?? photos[0]
  return (
    <>
      <Carousel setApi={setApi} className="w-full" aria-label="Photos">
        <CarouselContent>
          {photos.map((p) => (
            <CarouselItem key={p.full_url}>
              <PhotoImage photo={p} />
            </CarouselItem>
          ))}
        </CarouselContent>
        {photos.length > 1 && (
          <>
            <CarouselPrevious variant="map" className="left-2" />
            <CarouselNext variant="map" className="right-2" />
          </>
        )}
      </Carousel>
      <PhotoCaption photo={photo} index={current} count={photos.length} />
    </>
  )
}

function PhotoImage({ photo }: { photo: PoiPhoto }) {
  const [failed, setFailed] = useState(false)
  return (
    <a
      href={photo.page_url}
      target="_blank"
      rel="noreferrer"
      title="Open in a new tab"
      className="group relative block mx-auto aspect-4/3 w-[min(100%,calc(var(--poi-photo-height)*4/3))] overflow-hidden rounded-item bg-muted"
    >
      {failed ? (
        <span className="flex h-full items-center justify-center gap-1 text-xs text-muted-foreground">
          <ImageOff className="size-4" />
          Couldn't load this photo
        </span>
      ) : (
        <img
          src={photo.thumb_url}
          alt=""
          loading="lazy"
          // Third-party hosts (and any `image` URL a mapper typed) don't
          // need to know which page showed their picture.
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          className="h-full w-full object-contain"
        />
      )}
      <span className="absolute top-1.5 right-1.5 rounded-full bg-background/80 p-1 opacity-0 shadow-raised transition-opacity group-hover:opacity-100">
        <ExternalLink className="size-3.5" />
      </span>
    </a>
  )
}

function PhotoCaption({ photo, index, count }: { photo: PoiPhoto; index: number; count: number }) {
  const credit = [photo.author && `© ${photo.author}`, photo.license].filter(Boolean).join(" · ")
  return (
    <div className="mt-1 flex items-start justify-between gap-2 text-xs text-muted-foreground">
      <div className="min-w-0">
        <p>
          {photo.taken_at ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span>{formatRelativeDate(photo.taken_at)}</span>
              </TooltipTrigger>
              <TooltipContent>{formatExactDateTime(photo.taken_at)}</TooltipContent>
            </Tooltip>
          ) : (
            "Undated"
          )}{" "}
          · {PHOTO_SOURCE_LABELS[photo.source] ?? photo.source}
        </p>
        {credit && (
          <p className="truncate" title={credit}>
            {credit}
          </p>
        )}
      </div>
      {count > 1 && (
        <span className="shrink-0 tabular-nums">
          {index + 1} / {count}
        </span>
      )}
    </div>
  )
}

// Shown when an element has no photo: someone passing by is exactly who can
// fix that. Only a one-line trigger in the popup - the guide itself opens in
// a dialog, since expanding it inline resized the popup under the pointer.
function PhotoNudge({ name, osmEditUrl }: { name: string | null; osmEditUrl: string }) {
  return (
    <Dialog>
      <DialogTrigger className="mt-1 flex cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <Camera className="size-3.5" />
        No photo yet · <span className="text-primary underline">Add one</span>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a photo of {name ?? "this place"}</DialogTitle>
          <DialogDescription>
            A photo shows the next person what to expect. Everyone using OpenStreetMap sees it, not only Sulla Via.
          </DialogDescription>
        </DialogHeader>
        <section className="space-y-2 text-sm">
          <h3 className="font-medium">The easiest way: straight from your phone</h3>
          <p className="text-muted-foreground">
            Open this place in one of these apps and add a picture. The app uploads it to Panoramax and links it to
            the place for you.
          </p>
          <ul className="ml-4 list-disc space-y-1">
            <li>
              Android: <PhotoLinkOut href="https://play.google.com/store/apps/details?id=org.mapcomplete">MapComplete</PhotoLinkOut>
            </li>
            <li>
              iPhone: <PhotoLinkOut href="https://apps.apple.com/app/go-map/id592990211">Go Map!!</PhotoLinkOut>
            </li>
          </ul>
        </section>
        <section className="space-y-2 text-sm">
          <h3 className="font-medium">Or: take it now, link it later</h3>
          <ol className="ml-4 list-decimal space-y-1">
            <li>
              Take the photo with the <PhotoLinkOut href="https://panoramax.fr/">Panoramax</PhotoLinkOut> or{" "}
              <PhotoLinkOut href="https://www.mapillary.com/mobile-apps">Mapillary</PhotoLinkOut> app, and upload it.
            </li>
            <li>Copy the photo's id from its page.</li>
            <li>
              Open this place with <PhotoLinkOut href={osmEditUrl}>Edit on OpenStreetMap</PhotoLinkOut> and add a
              tag{" "}
              <PhotoLinkOut href="https://wiki.openstreetmap.org/wiki/Key:panoramax">
                <code>panoramax=&lt;id&gt;</code>
              </PhotoLinkOut>{" "}
              (or{" "}
              <PhotoLinkOut href="https://wiki.openstreetmap.org/wiki/Key:mapillary">
                <code>mapillary=&lt;id&gt;</code>
              </PhotoLinkOut>
              ).
            </li>
          </ol>
        </section>
      </DialogContent>
    </Dialog>
  )
}

function PhotoLinkOut({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-primary underline">
      {children}
    </a>
  )
}
