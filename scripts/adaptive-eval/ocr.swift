// Reads text off contact sheets with macOS's built-in text recognition (Vision). Built and run by
// label.mts; not part of the product, which never reads a burned-in clock.
//
//   ocr <rows> <image>...   prints "<image>\t<row>\t<text>" per line of text found, where <row> is the
//                           sheet row (of <rows> stacked frames) the text sits in. FAST=1: quicker, rougher.
import AppKit
import Foundation
import Vision

let args = CommandLine.arguments
let rows = Int(args[1])!
for path in args.dropFirst(2) {
  guard let img = NSImage(contentsOfFile: path), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { print("\(path)\t-1\tERR"); continue }
  let req = VNRecognizeTextRequest()
  req.recognitionLevel = ProcessInfo.processInfo.environment["FAST"] != nil ? .fast : .accurate
  req.usesLanguageCorrection = false
  try? VNImageRequestHandler(cgImage: cg).perform([req])
  for o in req.results ?? [] {
    guard let c = o.topCandidates(1).first else { continue }
    print("\(path)\t\(Int((1 - o.boundingBox.midY) * Double(rows)))\t\(c.string)")
  }
}
