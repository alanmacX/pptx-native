// Extract exact-time frames from a PowerPoint-exported movie (motion QA lane).
// Usage: swift tools/ppt_movie_frames.swift input.mov outdir [fps]
// Writes outdir/frame-<ms>.png at 1/fps intervals (default 4 fps).
import AVFoundation
import AppKit

let args = CommandLine.arguments
guard args.count >= 3 else {
    FileHandle.standardError.write("usage: ppt_movie_frames.swift input.mov outdir [fps]\n".data(using: .utf8)!)
    exit(1)
}
let url = URL(fileURLWithPath: args[1])
let outDir = URL(fileURLWithPath: args[2], isDirectory: true)
let fps = args.count > 3 ? (Double(args[3]) ?? 4.0) : 4.0
try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

let asset = AVURLAsset(url: url)
let duration = CMTimeGetSeconds(asset.duration)
guard duration > 0 else {
    FileHandle.standardError.write("empty or unreadable movie\n".data(using: .utf8)!)
    exit(2)
}
let gen = AVAssetImageGenerator(asset: asset)
gen.appliesPreferredTrackTransform = true
gen.requestedTimeToleranceBefore = .zero
gen.requestedTimeToleranceAfter = .zero

var t = 0.0
var count = 0
while t < duration {
    let time = CMTime(seconds: t, preferredTimescale: 600)
    if let cg = try? gen.copyCGImage(at: time, actualTime: nil) {
        let rep = NSBitmapImageRep(cgImage: cg)
        if let png = rep.representation(using: .png, properties: [:]) {
            let ms = Int((t * 1000).rounded())
            try? png.write(to: outDir.appendingPathComponent(String(format: "frame-%05d.png", ms)))
            count += 1
        }
    }
    t += 1.0 / fps
}
print("{\"ok\":true,\"durationSec\":\(duration),\"frames\":\(count)}")
