import {
  useRef,
  type ComponentPropsWithoutRef,
  type FC,
  type ReactNode,
} from "react"
import { motion, MotionValue, useScroll, useTransform } from "motion/react"

import { cn } from "@/lib/utils"

export interface TextRevealProps extends Omit<ComponentPropsWithoutRef<"div">, "children"> {
  children: string
  /** Shown above the words, inside the sticky frame. */
  heading?: ReactNode
  /** Classes for the words' block. */
  textClassName?: string
}

/** Magic UI's text reveal: each word lights up from grey to white as the section scrolls past. */
export const TextReveal: FC<TextRevealProps> = ({ children, className, heading, textClassName, ...props }) => {
  const sectionRef = useRef<HTMLDivElement | null>(null)
  const { scrollYProgress } = useScroll({
    target: sectionRef,
    offset: ["start start", "end end"],
  })

  if (typeof children !== "string") {
    throw new Error("TextReveal: children must be a string")
  }

  const words = children.split(" ")

  return (
    <div ref={sectionRef} className={cn("relative z-0 h-[200vh]", className)} {...props}>
      <div className="sticky top-0 mx-auto flex h-svh max-w-5xl flex-col justify-center gap-8 bg-transparent px-4">
        {heading}
        <p className={cn("flex flex-wrap text-2xl font-bold md:text-3xl lg:text-4xl xl:text-5xl", textClassName)}>
          {words.map((word, i) => {
            const start = i / words.length
            const end = start + 1 / words.length
            return (
              <Word key={i} progress={scrollYProgress} range={[start * 0.85, end * 0.85]}>
                {word}
              </Word>
            )
          })}
        </p>
      </div>
    </div>
  )
}

interface WordProps {
  children: ReactNode
  progress: MotionValue<number>
  range: [number, number]
}

const Word: FC<WordProps> = ({ children, progress, range }) => {
  const opacity = useTransform(progress, range, [0, 1])
  const blur = useTransform(progress, range, ["blur(6px)", "blur(0px)"])
  return (
    <span className="relative mr-[0.26em]">
      <span className="absolute text-white/[0.16]">{children}</span>
      <motion.span style={{ opacity, filter: blur }} className="text-white">
        {children}
      </motion.span>
    </span>
  )
}
