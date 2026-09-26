import Foundation

@main
struct TerminalDeletionTest {
  static func main() {
    let router = TerminalDeletionRouter()
    var sent = 0
    let emit = { sent += 1 }

    // Software keyboards may only send an empty replacement to the delegate.
    router.emptyReplacement(emit: emit)
    precondition(sent == 1)

    // UIKit may also invoke that delegate from the subclass's super call.
    router.deleteBackward(emit: emit, performSystemDelete: {
      router.emptyReplacement(emit: emit)
    })
    precondition(sent == 2)

    // A hardware-key callback can arrive without the editing delegate.
    router.deleteBackward(emit: emit, performSystemDelete: {})
    precondition(sent == 3)

    // Ownership resets after the call, so later software-keyboard deletes work.
    router.emptyReplacement(emit: emit)
    precondition(sent == 4)
  }
}
