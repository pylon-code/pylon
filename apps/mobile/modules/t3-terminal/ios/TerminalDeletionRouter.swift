/// Sends one terminal DEL for either UITextField deletion callback path.
/// `super.deleteBackward()` may synchronously call the editing delegate.
final class TerminalDeletionRouter {
  private var insideDeleteBackward = false

  func deleteBackward(emit: () -> Void, performSystemDelete: () -> Void) {
    insideDeleteBackward = true
    defer { insideDeleteBackward = false }
    emit()
    performSystemDelete()
  }

  func emptyReplacement(emit: () -> Void) {
    guard !insideDeleteBackward else { return }
    emit()
  }
}
